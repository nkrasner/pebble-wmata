#include <pebble.h>
#include "detail_window.h"
#include "schedule_window.h"
#include "trip_window.h"

#define MAX_STOPS 5
#define MAX_PREDS 5

typedef struct {
  char stop_id[16];
  char stop_name[48];
  char distance[16];
  char preds[MAX_PREDS][48]; 
  int num_preds;             
} StopItem;

static Window *s_main_window;
static StatusBarLayer *s_status_bar;
static MenuLayer *s_menu_layer;
static StopItem s_stops[MAX_STOPS];
static int s_num_stops = 0;

// --- LOADING ANIMATION STATE ---
static AppTimer *s_loading_timer;
static int s_loading_frame = 0;

static void loading_timer_callback(void *data) {
  s_loading_frame = (s_loading_frame + 1) % 4;
  if (s_num_stops == 0 && s_menu_layer) {
    layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
    s_loading_timer = app_timer_register(300, loading_timer_callback, NULL);
  }
}

static int32_t safe_get_int(Tuple *t) {
  if (!t) return 0;
  if (t->type == TUPLE_UINT) return t->length == 1 ? t->value->uint8 : (t->length == 2 ? t->value->uint16 : t->value->uint32);
  else if (t->type == TUPLE_INT) return t->length == 1 ? t->value->int8 : (t->length == 2 ? t->value->int16 : t->value->int32);
  return 0;
}

static uint16_t menu_get_num_rows_callback(MenuLayer *menu_layer, uint16_t section_index, void *data) {
  return s_num_stops == 0 ? 1 : s_num_stops;
}

static int16_t menu_get_cell_height_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *callback_context) {
  if (s_num_stops == 0) return 140; // Full screen for the loader
  StopItem *stop = &s_stops[cell_index->row];
  int lines = stop->num_preds > 0 ? stop->num_preds : 1;
  return 40 + (lines * 16); 
}

static void menu_draw_row_callback(GContext* ctx, const Layer *cell_layer, MenuIndex *cell_index, void *data) {
  GRect bounds = layer_get_bounds(cell_layer);
  
  if (s_num_stops == 0) {
    // FULL SCREEN LOADING ANIMATION
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
    const char* frames[] = {"LOADING", "LOADING.", "LOADING..", "LOADING..."};
    graphics_draw_text(ctx, frames[s_loading_frame], fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD), 
                       GRect(0, 50, bounds.size.w, 30), GTextOverflowModeFill, GTextAlignmentCenter, NULL);
    return;
  }

  StopItem *stop = &s_stops[cell_index->row];
  bool is_bus = (stop->stop_id[0] == 'B');
  bool is_highlighted = menu_cell_layer_is_highlighted(cell_layer);

  // DYNAMIC BACKGROUND COLORS
  #ifdef PBL_COLOR
    if (is_bus) {
      graphics_context_set_fill_color(ctx, is_highlighted ? GColorPictonBlue : GColorDukeBlue);
    } else {
      graphics_context_set_fill_color(ctx, is_highlighted ? GColorRajah : GColorWindsorTan);
    }
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    graphics_context_set_text_color(ctx, GColorWhite);
  #else
    graphics_context_set_text_color(ctx, is_highlighted ? GColorWhite : GColorBlack);
  #endif

  graphics_draw_text(ctx, stop->stop_name, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), GRect(4, -2, bounds.size.w - 8, 20), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_draw_text(ctx, stop->distance, fonts_get_system_font(FONT_KEY_GOTHIC_14), GRect(4, 18, bounds.size.w - 8, 16), GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  
  for (int i = 0; i < stop->num_preds; i++) {
    graphics_draw_text(ctx, stop->preds[i], fonts_get_system_font(FONT_KEY_GOTHIC_14), GRect(4, 34 + (i * 16), bounds.size.w - 8, 16), GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  }
}

static void menu_select_callback(MenuLayer *menu_layer, MenuIndex *cell_index, void *data) {
  if (s_num_stops == 0) return;
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  if (iter) { dict_write_uint8(iter, 0, 1); dict_write_cstring(iter, 1, s_stops[cell_index->row].stop_id); app_message_outbox_send(); }
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  Tuple *type_tuple = dict_find(iterator, 0);
  if (!type_tuple) return;
  int32_t req_type = safe_get_int(type_tuple); 

  if (req_type == 0) {
    Tuple *idx_tuple = dict_find(iterator, 4);
    if (!idx_tuple) return;
    int32_t index = safe_get_int(idx_tuple);

    if (index == -1) {
      s_num_stops = 0;
      if (s_menu_layer) layer_mark_dirty(menu_layer_get_layer(s_menu_layer));
      if (!s_loading_timer) s_loading_timer = app_timer_register(300, loading_timer_callback, NULL);
      return;
    }

    if (index >= 0 && index < MAX_STOPS) {
      Tuple *title_t = dict_find(iterator, 5); Tuple *sub_t = dict_find(iterator, 6); Tuple *id_t = dict_find(iterator, 1);
      if (title_t && sub_t && id_t) {
        snprintf(s_stops[index].stop_id, sizeof(s_stops[index].stop_id), "%s", id_t->value->cstring);
        snprintf(s_stops[index].stop_name, sizeof(s_stops[index].stop_name), "%s", title_t->value->cstring);
        char temp_sub[256]; snprintf(temp_sub, sizeof(temp_sub), "%s", sub_t->value->cstring);
        char *current_line = temp_sub; char *next_line;

        next_line = strchr(current_line, '\n');
        if (next_line) { *next_line = '\0'; snprintf(s_stops[index].distance, sizeof(s_stops[index].distance), "%s", current_line); current_line = next_line + 1; } 
        else { snprintf(s_stops[index].distance, sizeof(s_stops[index].distance), "%s", current_line); current_line = NULL; }

        s_stops[index].num_preds = 0;
        while (current_line && s_stops[index].num_preds < MAX_PREDS) {
          next_line = strchr(current_line, '\n');
          if (next_line) { *next_line = '\0'; snprintf(s_stops[index].preds[s_stops[index].num_preds], 48, "%s", current_line); current_line = next_line + 1; } 
          else { snprintf(s_stops[index].preds[s_stops[index].num_preds], 48, "%s", current_line); current_line = NULL; }
          s_stops[index].num_preds++;
        }

        if (index >= s_num_stops) s_num_stops = index + 1;
        if (s_menu_layer) menu_layer_reload_data(s_menu_layer);
      }
    }
  } 
  else if (req_type == 1) detail_window_handle_inbox(iterator);
  else if (req_type == 2) schedule_window_handle_inbox(iterator);
  else if (req_type == 3) trip_window_handle_inbox(iterator);
}

static void main_window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window); GRect bounds = layer_get_bounds(window_layer);

  s_status_bar = status_bar_layer_create();
  status_bar_layer_set_colors(s_status_bar, GColorCobaltBlue, GColorWhite);
  layer_add_child(window_layer, status_bar_layer_get_layer(s_status_bar));

  bounds.origin.y += STATUS_BAR_LAYER_HEIGHT; bounds.size.h -= STATUS_BAR_LAYER_HEIGHT;

  s_menu_layer = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){ .get_num_rows = menu_get_num_rows_callback, .get_cell_height = menu_get_cell_height_callback, .draw_row = menu_draw_row_callback, .select_click = menu_select_callback });
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(window_layer, menu_layer_get_layer(s_menu_layer));
  
  s_loading_timer = app_timer_register(300, loading_timer_callback, NULL);
}

static void main_window_unload(Window *window) {
  status_bar_layer_destroy(s_status_bar); menu_layer_destroy(s_menu_layer);
}

static void init() {
  s_main_window = window_create();
  window_set_window_handlers(s_main_window, (WindowHandlers) { .load = main_window_load, .unload = main_window_unload });
  app_message_register_inbox_received(inbox_received_callback); window_stack_push(s_main_window, true); app_message_open(1024, 128); 
}
static void deinit() { window_destroy(s_main_window); }
int main(void) { init(); app_event_loop(); deinit(); }