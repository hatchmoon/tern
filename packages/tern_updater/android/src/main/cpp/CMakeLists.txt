cmake_minimum_required(VERSION 3.18.1)
project(tern_probe C)
add_library(tern_probe SHARED tern_probe.c)
target_link_libraries(tern_probe dl)
