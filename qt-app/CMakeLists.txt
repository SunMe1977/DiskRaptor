# DiskRaptor Qt 6 + QtWebEngine
# Cross-platform: Windows + Linux (Ubuntu 24.04)
# No GTK, no WebKitGTK, no GLib dependencies

cmake_minimum_required(VERSION 3.20)
project(DiskRaptor
  VERSION 0.2.6
  DESCRIPTION "Ultra-fast disk space analyzer — Qt 6 Edition"
  LANGUAGES CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

# ── Find Qt 6 packages ───────────────────────────────────────
find_package(Qt6 REQUIRED COMPONENTS
  Core
  Gui
  Widgets
  WebEngineWidgets
  WebChannel
  Network
)

# ── Sources ───────────────────────────────────────────────────
set(SOURCES
  src/main.cpp
  src/webviewwindow.cpp
  src/ipcbridge.cpp
  src/scanner.cpp
  src/platform_utils.cpp
)

set(HEADERS
  src/webviewwindow.h
  src/ipcbridge.h
  src/scanner.h
  src/platform_utils.h
)

set(RESOURCES
  resources/resources.qrc
)

# ── Executable ────────────────────────────────────────────────
add_executable(${PROJECT_NAME}
  ${SOURCES}
  ${HEADERS}
  ${RESOURCES}
)

target_link_libraries(${PROJECT_NAME} PRIVATE
  Qt6::Core
  Qt6::Gui
  Qt6::Widgets
  Qt6::WebEngineWidgets
  Qt6::WebChannel
  Qt6::Network
)

target_include_directories(${PROJECT_NAME} PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# ── Platform-specific ─────────────────────────────────────────
if(WIN32)
  # Windows: single EXE, no console in release
  set_target_properties(${PROJECT_NAME} PROPERTIES
    WIN32_EXECUTABLE TRUE
  )
  target_compile_definitions(${PROJECT_NAME} PRIVATE PLATFORM_WINDOWS)
elseif(UNIX AND NOT APPLE)
  # Linux: standard ELF binary
  target_compile_definitions(${PROJECT_NAME} PRIVATE PLATFORM_LINUX)
endif()

# ── Copy frontend files next to binary ────────────────────────
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
    "${CMAKE_SOURCE_DIR}/../frontend"
    "$<TARGET_FILE_DIR:${PROJECT_NAME}>/frontend"
  COMMENT "Copying frontend files to build directory"
)

# ── Install ───────────────────────────────────────────────────
install(TARGETS ${PROJECT_NAME} RUNTIME DESTINATION bin)
install(DIRECTORY ../frontend/ DESTINATION share/${PROJECT_NAME}/frontend)

message(STATUS "DiskRaptor ${PROJECT_VERSION} — Qt 6 + QtWebEngine")
message(STATUS "  Build: ${CMAKE_SYSTEM_NAME} ${CMAKE_SYSTEM_PROCESSOR}")
message(STATUS "  Qt:    ${Qt6_VERSION}")
message(STATUS "  C++:   ${CMAKE_CXX_STANDARD}")
