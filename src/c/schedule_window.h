#pragma once
#include <pebble.h>

void schedule_window_push(const char *title_text);
void schedule_window_handle_inbox(DictionaryIterator *iterator);