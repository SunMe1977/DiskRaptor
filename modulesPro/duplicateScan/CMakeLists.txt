# DiskRaptor Duplicate Scan Pro Module
# Builds as shared library (.dll / .so / .dylib)
cmake_minimum_required(VERSION 3.20)
project(duplicateScan VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_library(${PROJECT_NAME} SHARED
    duplicate_scan.cpp
)

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_SOURCE_DIR}/include
)

# No external dependencies — pure C++17
# Output goes to modulesPro/
set_target_properties(${PROJECT_NAME} PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../modulesPro"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../modulesPro"
)

if(WIN32)
    set_target_properties(${PROJECT_NAME} PROPERTIES
        SUFFIX ".dll"
    )
elseif(APPLE)
    set_target_properties(${PROJECT_NAME} PROPERTIES
        SUFFIX ".dylib"
    )
endif()

message(STATUS "Building Pro Module: ${PROJECT_NAME}")
