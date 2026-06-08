#include "trip_window.h"

#define MAX_TRIP_STOPS 80
static Window *s_trip_window = NULL;
static StatusBarLayer *s_status_bar;
static Layer *s_top_bar_layer;
static MenuLayer *s_menu_layer;

static char s_title_buffer[48];
typedef struct { char stop_name[64]; char time[16]; } TripStop;
static TripStop s_stops[MAX_TRIP_STOPS];
static int s_num_stops = 0; static int s_next_index = 0;

static void top_bar_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  #ifdef PBL_COLOR
    graphics_context_set_fill_color(ctx, GColorDukeBlue);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
  #else
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
  #endif
  
  // STANDARDIZED BREADCRUMB
  graphics_draw_text(ctx, s_title_buffer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), 
                     GRect(4, 2, bounds.size.w - 8, 16), GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static uint16_t menu_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) { return s_num_stops == 0 ? 1 : s_num_stops; }
static int16_t menu_get_cell_height_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *callback_context) { return 44; }

static void menu_draw_row_callback(GContext* ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
  GRect bounds = layer_get_bounds(cell_layer); bool is_highlighted = menu_cell_layer_is_highlighted(cell_layer);
  GColor main_color = is_highlighted ? GColorWhite : GColorBlack; GColor dim_color = is_highlighted ? GColorLightGray : GColorDarkGray;

  if (s_num_stops == 0) {
    graphics_context_set_text_color(ctx, main_color); graphics_draw_text(ctx, "Loading stops...", fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(4, 8, bounds.size.w - 8, 24), GTextOverflowModeFill, GTextAlignmentCenter, NULL);
    return;
  }
  TripStop *stop = &s_stops[cell_index->row];
  graphics_context_set_text_color(ctx, main_color); graphics_draw_text(ctx, stop->stop_name, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(4, 8, bounds.size.w - 55, 24), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_context_set_text_color(ctx, dim_color); graphics_draw_text(ctx, stop->time, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(bounds.size.w - 55, 8, 51, 24), GTextOverflowModeFill, GTextAlignmentRight, NULL);
}

static void trip_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window); 
  GRect bounds = layer_get_bounds(window_layer);
  
  s_status_bar = status_bar_layer_create();
  #ifdef PBL_COLOR
    status_bar_layer_set_colors(s_status_bar, GColorDukeBlue, GColorWhite);
  #else
    status_bar_layer_set_colors(s_status_bar, GColorBlack, GColorWhite);
  #endif
  layer_add_child(window_layer, status_bar_layer_get_layer(s_status_bar));

  bounds.origin.y += STATUS_BAR_LAYER_HEIGHT; 
  bounds.size.h -= STATUS_BAR_LAYER_HEIGHT;

  // SHRUNK: 36px down to 22px
  s_top_bar_layer = layer_create(GRect(0, bounds.origin.y, bounds.size.w, 22));
  layer_set_update_proc(s_top_bar_layer, top_bar_update_proc); 
  layer_add_child(window_layer, s_top_bar_layer);
  
  s_menu_layer = menu_layer_create(GRect(0, bounds.origin.y + 22, bounds.size.w, bounds.size.h - 22));
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){ 
    .get_num_rows = menu_get_num_rows_callback, 
    .get_cell_height = menu_get_cell_height_callback, 
    .draw_row = menu_draw_row_callback 
  });
  
  #ifdef PBL_COLOR
    menu_layer_set_highlight_colors(s_menu_layer, GColorOrange, GColorWhite);
  #endif
  
  menu_layer_set_click_config_onto_window(s_menu_layer, window); 
  layer_add_child(window_layer, menu_layer_get_layer(s_menu_layer));
}

static void trip_window_unload(Window *window) {
  if (s_status_bar) status_bar_layer_destroy(s_status_bar);
  if (s_top_bar_layer) layer_destroy(s_top_bar_layer);
  if (s_menu_layer) menu_layer_destroy(s_menu_layer);
}

void trip_window_push(const char *title_text) {
  snprintf(s_title_buffer, sizeof(s_title_buffer), "%s", title_text);
  if (!s_trip_window) { s_trip_window = window_create(); window_set_window_handlers(s_trip_window, (WindowHandlers) { .load = trip_window_load, .unload = trip_window_unload }); }
  window_stack_push(s_trip_window, true); 
  if (window_is_loaded(s_trip_window) && s_top_bar_layer) layer_mark_dirty(s_top_bar_layer);
}

static int32_t safe_get_int(Tuple *t) {
  if (!t) return 0;
  if (t->type == TUPLE_UINT) { if (t->length == 1) return t->value->uint8; if (t->length == 2) return t->value->uint16; if (t->length == 4) return t->value->uint32; }
  else if (t->type == TUPLE_INT) { if (t->length == 1) return t->value->int8; if (t->length == 2) return t->value->int16; if (t->length == 4) return t->value->int32; }
  return 0;
}

void trip_window_handle_inbox(DictionaryIterator *iterator) {
  Tuple *idx_tuple = dict_find(iterator, 4); if (!idx_tuple) return;
  int32_t index = safe_get_int(idx_tuple);

  if (index == -1) {
    s_num_stops = 0; s_next_index = 0; 
    Tuple *next_idx_tuple = dict_find(iterator, 2); if (next_idx_tuple) s_next_index = safe_get_int(next_idx_tuple);
    if (s_menu_layer) menu_layer_reload_data(s_menu_layer);
    Tuple *title_tuple = dict_find(iterator, 5); if (title_tuple) trip_window_push(title_tuple->value->cstring);
  } else if (index >= 0 && index < MAX_TRIP_STOPS) {
    Tuple *title_t = dict_find(iterator, 5); Tuple *sub_t = dict_find(iterator, 6);
    if (title_t && sub_t) {
      snprintf(s_stops[index].stop_name, sizeof(s_stops[index].stop_name), "%s", title_t->value->cstring);
      snprintf(s_stops[index].time, sizeof(s_stops[index].time), "%s", sub_t->value->cstring);
      if (index >= s_num_stops) s_num_stops = index + 1;
      if (s_menu_layer) {
        menu_layer_reload_data(s_menu_layer);
        if (index == s_next_index) menu_layer_set_selected_index(s_menu_layer, (MenuIndex){.section = 0, .row = s_next_index}, MenuRowAlignCenter, false);
      }
    }
  }
}