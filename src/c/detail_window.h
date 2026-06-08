#pragma once
#include <pebble.h>

void detail_window_push(int32_t initial_bearing, const char *distance_text, const char *stop_name);
void detail_window_handle_inbox(DictionaryIterator *iterator);