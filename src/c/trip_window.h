#pragma once
#include <pebble.h>

void trip_window_push(const char *title_text);
void trip_window_handle_inbox(DictionaryIterator *iterator);