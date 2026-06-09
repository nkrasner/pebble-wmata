#include <pebble.h>

#define MAX_PAGES 10
#define MAX_ROWS 5

typedef struct {
  char route[8];
  char dest[24];
  char time[8];
} TransitRow;

typedef struct {
  char stop_id[16];
  char name[48];
  char dist[16];
  bool is_pinned;
  bool is_rail;
  TransitRow rows[MAX_ROWS];
  int num_rows;
} TransitPage;

static Window *s_main_window;
static Layer *s_page_layer;
static TransitPage s_pages[MAX_PAGES];
static int s_num_pages = 0;
static int s_current_page = 0;
static int s_first_nearby_idx = 0; 

static GBitmap *s_icon_bus;
static GBitmap *s_icon_train;

static Window *s_action_window = NULL;
static SimpleMenuLayer *s_action_menu = NULL;
static SimpleMenuSection s_action_sections[1];
static SimpleMenuItem s_action_items[3];

static AppTimer *s_loading_timer = NULL;
static int s_loading_frame = 0;

// --- SAFE TIMER LOOP ---
static void loading_timer_callback(void *data) {
  s_loading_frame = (s_loading_frame + 1) % 4;
  if (s_num_pages == 0 && s_page_layer) {
    layer_mark_dirty(s_page_layer);
    s_loading_timer = app_timer_register(300, loading_timer_callback, NULL);
  } else {
    s_loading_timer = NULL; 
  }
}

// --- DYNAMIC COLOR GENERATOR ---
static GColor get_route_color(const char* route_id) {
  #ifndef PBL_COLOR
    return GColorBlack;
  #endif
  if (strcmp(route_id, "RD") == 0) return GColorRed;
  if (strcmp(route_id, "OR") == 0) return GColorOrange;
  if (strcmp(route_id, "BL") == 0) return GColorBlue;
  if (strcmp(route_id, "YL") == 0) return GColorYellow;
  if (strcmp(route_id, "GR") == 0) return GColorGreen;
  if (strcmp(route_id, "SV") == 0) return GColorLightGray;

  int hash = 0; for (int j = 0; route_id[j] != '\0'; j++) hash = (hash * 31) + route_id[j];
  uint8_t r = (hash % 3) + 1; uint8_t g = ((hash / 3) % 3) + 1; uint8_t b = ((hash / 9) % 3) + 1;
  return (GColor){ .argb = (uint8_t)(0xC0 | (r << 4) | (g << 2) | b) };
}

// --- RENDER ENGINE ---
static void page_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorWhite);
  graphics_fill_rect(ctx, bounds, 0, GCornerNone);

  if (s_num_pages == 0) {
    graphics_context_set_text_color(ctx, GColorBlack);
    const char* frames[] = {"Scanning Area", "Scanning Area.", "Scanning Area..", "Scanning Area..."};
    graphics_draw_text(ctx, frames[s_loading_frame], fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD), GRect(0, 60, bounds.size.w, 30), GTextOverflowModeFill, GTextAlignmentCenter, NULL);
    return;
  }

  // Bounds safety guard
  if (s_current_page >= s_num_pages) s_current_page = s_num_pages - 1;
  if (s_current_page < 0) s_current_page = 0;
  
  TransitPage *p = &s_pages[s_current_page];

  // 1. Top Bar
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, GRect(0, 0, bounds.size.w, 20), 0, GCornerNone);
  
  char time_str[16];
  clock_copy_time_string(time_str, sizeof(time_str));
  graphics_context_set_text_color(ctx, GColorWhite);
  graphics_draw_text(ctx, time_str, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), GRect(4, 0, 50, 20), GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  
  graphics_context_set_text_color(ctx, p->is_pinned ? GColorYellow : GColorWhite);
  graphics_draw_text(ctx, p->dist, fonts_get_system_font(FONT_KEY_GOTHIC_14), GRect(bounds.size.w - 64, 0, 60, 20), GTextOverflowModeFill, GTextAlignmentRight, NULL);

  // 2. Stop Header
  GBitmap *target_icon = p->is_rail ? s_icon_train : s_icon_bus;
  if (target_icon) {
    graphics_context_set_compositing_mode(ctx, GCompOpSet);
    graphics_draw_bitmap_in_rect(ctx, target_icon, GRect(4, 22, 24, 24));
  }
  
  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, p->name, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(32, 22, bounds.size.w - 36, 24), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

  // 3. Rows
  int y_offset = 50;
  for (int i = 0; i < p->num_rows; i++) {
    TransitRow *row = &p->rows[i];
    
    #ifdef PBL_COLOR
      graphics_context_set_fill_color(ctx, get_route_color(row->route));
      graphics_fill_rect(ctx, GRect(4, y_offset, 32, 22), 4, GCornersAll);
      graphics_context_set_text_color(ctx, GColorWhite);
    #else
      graphics_context_set_text_color(ctx, GColorBlack);
    #endif

    graphics_draw_text(ctx, row->route, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), GRect(4, y_offset + 1, 32, 20), GTextOverflowModeFill, GTextAlignmentCenter, NULL);
    
    graphics_context_set_text_color(ctx, GColorBlack);
    graphics_draw_text(ctx, row->dest, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(40, y_offset - 2, bounds.size.w - 74, 24), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    graphics_draw_text(ctx, row->time, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(bounds.size.w - 34, y_offset - 2, 30, 24), GTextOverflowModeFill, GTextAlignmentRight, NULL);
    
    y_offset += 24;
  }
}

// --- BUTTON HANDLERS ---
static void up_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_current_page > 0) { s_current_page--; layer_mark_dirty(s_page_layer); }
}

static void down_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_current_page < s_num_pages - 1) { s_current_page++; layer_mark_dirty(s_page_layer); }
}

// --- ACTION MENU ---
static void menu_action_callback(int index, void *context) {
  DictionaryIterator *iter; 
  app_message_outbox_begin(&iter);
  if (iter) {
    int cmd = 4; 
    if (index == 1) cmd = 5;
    else if (index == 2) cmd = 6;

    dict_write_uint8(iter, 0, cmd);
    dict_write_cstring(iter, 1, s_pages[s_current_page].stop_id);
    app_message_outbox_send();
    
    window_stack_pop(true);
    s_num_pages = 0; 
    layer_mark_dirty(s_page_layer); 
    if (!s_loading_timer) s_loading_timer = app_timer_register(300, loading_timer_callback, NULL);
  }
}

static void select_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_num_pages == 0) return;
  TransitPage *p = &s_pages[s_current_page];
  
  int i = 0;
  s_action_items[i++] = (SimpleMenuItem){ .title = p->is_pinned ? "Unpin Location" : "Pin Location", .callback = menu_action_callback, .icon = NULL };
  if (p->is_pinned) {
    s_action_items[i++] = (SimpleMenuItem){ .title = "Move Pin Up", .callback = menu_action_callback, .icon = NULL };
    s_action_items[i++] = (SimpleMenuItem){ .title = "Move Pin Down", .callback = menu_action_callback, .icon = NULL };
  }
  
  s_action_sections[0] = (SimpleMenuSection){ .num_items = i, .items = s_action_items };
  
  if (!s_action_window) { s_action_window = window_create(); }
  
  // FORTIFIED: Safely remove ghost layers before destroying them!
  if (s_action_menu) {
    layer_remove_from_parent(simple_menu_layer_get_layer(s_action_menu));
    simple_menu_layer_destroy(s_action_menu);
  }
  
  s_action_menu = simple_menu_layer_create(layer_get_bounds(window_get_root_layer(s_action_window)), s_action_window, s_action_sections, 1, NULL);
  layer_add_child(window_get_root_layer(s_action_window), simple_menu_layer_get_layer(s_action_menu));
  window_stack_push(s_action_window, true);
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click_handler);
}

// --- DATA PARSER ---
static int32_t safe_get_int(Tuple *t) { 
  if (!t) return 0; 
  if (t->type == TUPLE_UINT) return t->length == 1 ? t->value->uint8 : (t->length == 2 ? t->value->uint16 : t->value->uint32); 
  else if (t->type == TUPLE_INT) return t->length == 1 ? t->value->int8 : (t->length == 2 ? t->value->int16 : t->value->int32); 
  return 0; 
}

static char s_raw_data_buffer[512]; 

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  Tuple *type_t = dict_find(iterator, 0); if (!type_t || safe_get_int(type_t) != 0) return;
  Tuple *idx_t = dict_find(iterator, 4); if (!idx_t) return;
  int index = safe_get_int(idx_t);

  if (index == -1) {
    s_num_pages = 0; 
    Tuple *bear_t = dict_find(iterator, 2);
    if (bear_t) {
      s_first_nearby_idx = safe_get_int(bear_t);
      if (s_first_nearby_idx >= MAX_PAGES) s_first_nearby_idx = MAX_PAGES - 1;
      if (s_first_nearby_idx < 0) s_first_nearby_idx = 0;
    }
    return;
  }

  if (index >= 0 && index < MAX_PAGES) {
    Tuple *id_t = dict_find(iterator, 1); 
    Tuple *title_t = dict_find(iterator, 5); 
    Tuple *sub_t = dict_find(iterator, 6);
    
    // Type checking safety guard
    if (id_t && title_t && sub_t && sub_t->type == TUPLE_CSTRING && title_t->type == TUPLE_CSTRING) {
      TransitPage *p = &s_pages[index];
      snprintf(p->stop_id, sizeof(p->stop_id), "%s", id_t->value->cstring);
      snprintf(p->name, sizeof(p->name), "%s", title_t->value->cstring);
      snprintf(s_raw_data_buffer, sizeof(s_raw_data_buffer), "%s", sub_t->value->cstring);
      
      // FORTIFIED PARSER: Using absolute pointers instead of strtok
      char *dist_tok = s_raw_data_buffer;
      char *pin_tok = strchr(dist_tok, '^'); if (pin_tok) { *pin_tok = '\0'; pin_tok++; }
      char *type_tok = pin_tok ? strchr(pin_tok, '^') : NULL; if (type_tok) { *type_tok = '\0'; type_tok++; }
      char *rows_tok = type_tok ? strchr(type_tok, '^') : NULL; if (rows_tok) { *rows_tok = '\0'; rows_tok++; }
      
      snprintf(p->dist, sizeof(p->dist), "%s", dist_tok ? dist_tok : "");
      p->is_pinned = (pin_tok && pin_tok[0] == '1');
      p->is_rail = (type_tok && type_tok[0] == 'R');
      
      p->num_rows = 0;
      char *row_str = rows_tok;
      
      while (row_str && *row_str && p->num_rows < MAX_ROWS) {
        char *next_row = strchr(row_str, '~');
        if (next_row) { *next_row = '\0'; next_row++; }
        
        char *rt = row_str;
        char *sep1 = strchr(rt, '|'); if (sep1) { *sep1 = '\0'; }
        char *dest = sep1 ? sep1 + 1 : "";
        char *sep2 = strchr(dest, '|'); if (sep2) { *sep2 = '\0'; }
        char *time = sep2 ? sep2 + 1 : "";
        
        snprintf(p->rows[p->num_rows].route, 8, "%s", rt);
        snprintf(p->rows[p->num_rows].dest, 24, "%s", dest);
        snprintf(p->rows[p->num_rows].time, 8, "%s", time);
        p->num_rows++;
        
        row_str = next_row;
      }
      
      if (index >= s_num_pages) s_num_pages = index + 1;
      
      if (s_num_pages - 1 == s_first_nearby_idx) {
        s_current_page = s_first_nearby_idx;
        layer_mark_dirty(s_page_layer);
      } else if (index == s_num_pages - 1) {
        layer_mark_dirty(s_page_layer);
      }
    }
  }
}

// --- SYSTEM ---
static void main_window_load(Window *window) {
  s_icon_bus = gbitmap_create_with_resource(RESOURCE_ID_ICON_BUS);
  s_icon_train = gbitmap_create_with_resource(RESOURCE_ID_ICON_TRAIN);

  Layer *window_layer = window_get_root_layer(window); 
  GRect bounds = layer_get_bounds(window_layer);
  s_page_layer = layer_create(bounds);
  layer_set_update_proc(s_page_layer, page_update_proc);
  layer_add_child(window_layer, s_page_layer);
  
  window_set_click_config_provider(window, click_config_provider);
  s_loading_timer = app_timer_register(300, loading_timer_callback, NULL);
}

static void main_window_unload(Window *window) {
  if (s_loading_timer) app_timer_cancel(s_loading_timer);
  if (s_icon_bus) gbitmap_destroy(s_icon_bus); 
  if (s_icon_train) gbitmap_destroy(s_icon_train);
  layer_destroy(s_page_layer);
}

static void init() {
  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers) { .load = main_window_load, .unload = main_window_unload });
  app_message_register_inbox_received(inbox_received_callback); 
  window_stack_push(s_main_window, true); 
  app_message_open(1024, 128); 
}

static void deinit() { window_destroy(s_main_window); }
int main(void) { init(); app_event_loop(); deinit(); }