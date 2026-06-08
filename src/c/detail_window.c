#include "detail_window.h"
#define MAX_BUSES 10

static bool s_enable_compass = false;
typedef struct { char bus_id[16]; char title[48]; char time[16]; } BusItem;

static Window *s_detail_window = NULL;
static StatusBarLayer *s_status_bar;
static Layer *s_top_bar_layer;
static MenuLayer *s_menu_layer;

static int32_t s_target_bearing = 0; static int32_t s_current_heading = 0;
static char s_stop_name_buffer[48]; static char s_distance_buffer[32];
static BusItem s_buses[MAX_BUSES]; static int s_num_buses = 0;

static AppTimer *s_loading_timer;
static int s_loading_frame = 0;

static void loading_timer_callback(void *data) {
  s_loading_frame = (s_loading_frame + 1) % 4;
  if (s_num_buses == 0 && s_menu_layer) {
    layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
    s_loading_timer = app_timer_register(300, loading_timer_callback, NULL);
  }
}

// --- COLOR GENERATOR ENGINE ---
static GColor get_route_color(const char* title) {
  #ifndef PBL_COLOR
    return GColorBlack;
  #endif
  
  char route_id[8] = {0};
  int i = 0;
  // Extract just the route ID (stop at the first space)
  while (title[i] != '\0' && title[i] != ' ' && i < 7) {
    route_id[i] = title[i];
    i++;
  }
  route_id[i] = '\0';

  // Explicit mapping for Metro Trains
  if (strcmp(route_id, "RD") == 0) return GColorRed;
  if (strcmp(route_id, "OR") == 0) return GColorOrange;
  if (strcmp(route_id, "BL") == 0) return GColorBlue;
  if (strcmp(route_id, "YL") == 0) return GColorYellow;
  if (strcmp(route_id, "GR") == 0) return GColorGreen;
  if (strcmp(route_id, "SV") == 0) return GColorLightGray;

  // Hashing for Bus Routes
  int hash = 0;
  for (int j = 0; route_id[j] != '\0'; j++) {
    hash = (hash * 31) + route_id[j];
  }
  
  // Pebble colors are built using 0xC0 | (R<<4) | (G<<2) | B, where RGB are 0-3.
  // We use (hash % 3) + 1 to avoid 0 (black/dark colors) so buses are bright and readable.
  uint8_t r = (hash % 3) + 1;
  uint8_t g = ((hash / 3) % 3) + 1;
  uint8_t b = ((hash / 9) % 3) + 1;
  return (GColor){ .argb = (uint8_t)(0xC0 | (r << 4) | (g << 2) | b) };
}

static void compass_heading_handler(CompassHeadingData heading_data) {
  if (!s_enable_compass) return;
  s_current_heading = TRIGANGLE_TO_DEG(heading_data.true_heading);
  if (s_top_bar_layer) layer_mark_dirty(s_top_bar_layer); 
}

static void top_bar_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_text_color(ctx, GColorBlack);
  
  graphics_draw_text(ctx, s_stop_name_buffer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), GRect(4, 2, bounds.size.w - 8, 16), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);

  if (s_enable_compass) {
    graphics_draw_text(ctx, s_distance_buffer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(8, 20, bounds.size.w - 40, 20), GTextOverflowModeFill, GTextAlignmentLeft, NULL);
    GPoint center = GPoint(bounds.size.w - 24, 30);
    int32_t draw_angle = s_current_heading - s_target_bearing; if (draw_angle < 0) draw_angle += 360;
    int32_t trig_angle = DEG_TO_TRIGANGLE(draw_angle);
    graphics_context_set_stroke_color(ctx, GColorBlack);
    graphics_context_set_stroke_width(ctx, 4);
    int16_t length = 10;
    GPoint end_point = GPoint(center.x + (sin_lookup(trig_angle) * length / TRIG_MAX_RATIO), center.y - (cos_lookup(trig_angle) * length / TRIG_MAX_RATIO));
    graphics_draw_line(ctx, center, end_point); graphics_context_set_fill_color(ctx, GColorBlack); graphics_fill_circle(ctx, center, 4);
  } else {
    graphics_draw_text(ctx, s_distance_buffer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(0, 20, bounds.size.w, 20), GTextOverflowModeFill, GTextAlignmentCenter, NULL);
  }
}

static uint16_t menu_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) { return s_num_buses == 0 ? 1 : s_num_buses; }
static int16_t menu_get_cell_height_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *callback_context) { return s_num_buses == 0 ? 100 : 44; }

static void menu_draw_row_callback(GContext* ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
  GRect bounds = layer_get_bounds(cell_layer); 
  
  if (s_num_buses == 0) {
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
    const char* frames[] = {"LOADING", "LOADING.", "LOADING..", "LOADING..."};
    graphics_draw_text(ctx, frames[s_loading_frame], fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD), 
                       GRect(0, 30, bounds.size.w, 30), GTextOverflowModeFill, GTextAlignmentCenter, NULL);
    return;
  }
  
  BusItem *bus = &s_buses[cell_index->row];
  bool is_highlighted = menu_cell_layer_is_highlighted(cell_layer);
  
  GColor route_color = get_route_color(bus->title);
  
  #ifdef PBL_COLOR
    // Draw the colored block for the Route ID
    graphics_context_set_fill_color(ctx, route_color);
    graphics_fill_rect(ctx, GRect(4, 6, 36, 32), 4, GCornersAll);
    
    // Default text colors
    graphics_context_set_text_color(ctx, is_highlighted ? GColorWhite : GColorBlack);
    
    // Draw Route ID text centered in its block
    char route_id[8] = {0};
    int i = 0;
    while (bus->title[i] != '\0' && bus->title[i] != ' ' && i < 7) { route_id[i] = bus->title[i]; i++; }
    
    // Make text white inside the block if it's not a light color
    graphics_context_set_text_color(ctx, GColorWhite); 
    graphics_draw_text(ctx, route_id, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(4, 10, 36, 24), GTextOverflowModeFill, GTextAlignmentCenter, NULL);
    
    // Draw the rest of the text normally
    graphics_context_set_text_color(ctx, is_highlighted ? GColorWhite : GColorBlack);
    graphics_draw_text(ctx, bus->title + i + 1, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(44, 8, bounds.size.w - 90, 24), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    graphics_context_set_text_color(ctx, is_highlighted ? GColorLightGray : GColorDarkGray);
    graphics_draw_text(ctx, bus->time, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(bounds.size.w - 50, 8, 46, 24), GTextOverflowModeFill, GTextAlignmentRight, NULL);
  #else
    // B&W Fallback
    graphics_context_set_text_color(ctx, is_highlighted ? GColorWhite : GColorBlack);
    graphics_draw_text(ctx, bus->title, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(4, 8, bounds.size.w - 50, 24), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    graphics_draw_text(ctx, bus->time, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(bounds.size.w - 50, 8, 46, 24), GTextOverflowModeFill, GTextAlignmentRight, NULL);
  #endif
}

static void menu_select_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  if (s_num_buses == 0) return;
  DictionaryIterator *iter; app_message_outbox_begin(&iter);
  if (iter) { dict_write_uint8(iter, 0, 2); dict_write_cstring(iter, 1, s_buses[cell_index->row].bus_id); app_message_outbox_send(); }
}

static void detail_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window); GRect bounds = layer_get_bounds(window_layer);
  
  s_status_bar = status_bar_layer_create();
  status_bar_layer_set_colors(s_status_bar, GColorClear, GColorBlack); 
  layer_add_child(window_layer, status_bar_layer_get_layer(s_status_bar));

  bounds.origin.y += STATUS_BAR_LAYER_HEIGHT; bounds.size.h -= STATUS_BAR_LAYER_HEIGHT;

  s_top_bar_layer = layer_create(GRect(0, bounds.origin.y, bounds.size.w, 44));
  layer_set_update_proc(s_top_bar_layer, top_bar_update_proc); layer_add_child(window_layer, s_top_bar_layer);
  
  s_menu_layer = menu_layer_create(GRect(0, bounds.origin.y + 44, bounds.size.w, bounds.size.h - 44));
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){ .get_num_rows = menu_get_num_rows_callback, .get_cell_height = menu_get_cell_height_callback, .draw_row = menu_draw_row_callback, .select_click = menu_select_callback });
  menu_layer_set_click_config_onto_window(s_menu_layer, window); layer_add_child(window_layer, menu_layer_get_layer(s_menu_layer));
  
  if (s_enable_compass) { compass_service_subscribe(compass_heading_handler); compass_service_set_heading_filter(DEG_TO_TRIGANGLE(2)); }
  s_loading_timer = app_timer_register(300, loading_timer_callback, NULL);
}

static void detail_window_unload(Window *window) {
  if (s_enable_compass) compass_service_unsubscribe();
  if (s_status_bar) status_bar_layer_destroy(s_status_bar);
  if (s_top_bar_layer) layer_destroy(s_top_bar_layer);
  if (s_menu_layer) menu_layer_destroy(s_menu_layer);
}

void detail_window_push(int32_t initial_bearing, const char *distance_text, const char *stop_name) {
  snprintf(s_distance_buffer, sizeof(s_distance_buffer), "%s", distance_text); snprintf(s_stop_name_buffer, sizeof(s_stop_name_buffer), "%s", stop_name);
  if (!s_detail_window) { s_detail_window = window_create(); window_set_window_handlers(s_detail_window, (WindowHandlers) { .load = detail_window_load, .unload = detail_window_unload }); }
  window_stack_push(s_detail_window, true); 
  if (window_is_loaded(s_detail_window) && s_top_bar_layer) layer_mark_dirty(s_top_bar_layer);
}

static int32_t safe_get_int(Tuple *t) {
  if (!t) return 0;
  if (t->type == TUPLE_UINT) { if (t->length == 1) return t->value->uint8; if (t->length == 2) return t->value->uint16; if (t->length == 4) return t->value->uint32; }
  else if (t->type == TUPLE_INT) { if (t->length == 1) return t->value->int8; if (t->length == 2) return t->value->int16; if (t->length == 4) return t->value->int32; }
  return 0;
}

void detail_window_handle_inbox(DictionaryIterator *iterator) {
  Tuple *idx_tuple = dict_find(iterator, 4); if (!idx_tuple) return;
  int32_t index = safe_get_int(idx_tuple);

  if (index == -1) {
    s_num_buses = 0; if (s_menu_layer) layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
    if (!s_loading_timer) s_loading_timer = app_timer_register(300, loading_timer_callback, NULL);
    Tuple *b_t = dict_find(iterator, 2); Tuple *d_t = dict_find(iterator, 3); Tuple *title_t = dict_find(iterator, 5);
    if (b_t && d_t && title_t) detail_window_push(safe_get_int(b_t), d_t->value->cstring, title_t->value->cstring);
  } else if (index >= 0 && index < MAX_BUSES) {
    Tuple *title_t = dict_find(iterator, 5); Tuple *sub_t = dict_find(iterator, 6); Tuple *id_t = dict_find(iterator, 1);
    if (title_t && sub_t && id_t) {
      snprintf(s_buses[index].bus_id, sizeof(s_buses[index].bus_id), "%s", id_t->value->cstring);
      snprintf(s_buses[index].title, sizeof(s_buses[index].title), "%s", title_t->value->cstring);
      snprintf(s_buses[index].time, sizeof(s_buses[index].time), "%s", sub_t->value->cstring);
      if (index >= s_num_buses) s_num_buses = index + 1;
      if (s_menu_layer) menu_layer_reload_data(s_menu_layer);
    }
  }
}