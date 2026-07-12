# DiskRaptor Qt 6 + QtWebEngine
cmake_minimum_required(VERSION 3.20)
project(DiskRaptor VERSION 0.2.7 DESCRIPTION "Ultra-fast disk space analyzer — Qt 6 Edition" LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets WebEngineWidgets WebChannel Network)

set(SOURCES src/main.cpp src/webviewwindow.cpp src/ipcbridge.cpp src/scanner.cpp src/platform_utils.cpp src/modules/module_loader.cpp)
set(HEADERS src/webviewwindow.h src/ipcbridge.h src/scanner.h src/platform_utils.h src/modules/module_loader.h)
set(RESOURCES resources/resources.qrc)

add_executable(${PROJECT_NAME} ${SOURCES} ${HEADERS} ${RESOURCES})

target_link_libraries(${PROJECT_NAME} PRIVATE
  Qt6::Core Qt6::Gui Qt6::Widgets Qt6::WebEngineWidgets Qt6::WebChannel Qt6::Network)

target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

if(WIN32)
  set_target_properties(${PROJECT_NAME} PROPERTIES WIN32_EXECUTABLE TRUE)
  target_compile_definitions(${PROJECT_NAME} PRIVATE PLATFORM_WINDOWS)
elseif(UNIX AND NOT APPLE)
  target_compile_definitions(${PROJECT_NAME} PRIVATE PLATFORM_LINUX)
endif()

# Copy frontend + modules after build
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../frontend" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/frontend")
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../modulesPro" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/modulesPro")

# ── Launcher (no Qt deps, Win32 only) ──────────────────────────
if(WIN32)
  add_executable(DiskRaptorLauncher WIN32 src/launcher.cpp)
  target_link_libraries(DiskRaptorLauncher PRIVATE
    kernel32 user32 shell32 wininet)
  set_target_properties(DiskRaptorLauncher PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "$<TARGET_FILE_DIR:${PROJECT_NAME}>")
  install(TARGETS DiskRaptorLauncher RUNTIME DESTINATION bin)
endif()

# ── Install ──────────────────────────────────────────────────
install(TARGETS ${PROJECT_NAME} RUNTIME DESTINATION bin)

# Install core DLLs (windeployqt output) — exclude WebEngine ones
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/"
  DESTINATION bin
  FILES_MATCHING
    PATTERN "*.dll"
    PATTERN "*.exe"
    PATTERN "*.pak"
    PATTERN "*.dat"
    PATTERN "*.bin"
    PATTERN "Qt6WebEngine*" EXCLUDE
  PATTERN "frontend" EXCLUDE
)

# Install plugin subdirectories (exclude QML/WebEngine)
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/platforms/" DESTINATION bin/platforms OPTIONAL)
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/styles/" DESTINATION bin/styles OPTIONAL)
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/imageformats/" DESTINATION bin/imageformats OPTIONAL)
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/tls/" DESTINATION bin/tls OPTIONAL)
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/iconengines/" DESTINATION bin/iconengines OPTIONAL)
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/generic/" DESTINATION bin/generic OPTIONAL)
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/networkinformation/" DESTINATION bin/networkinformation OPTIONAL)
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/resources/" DESTINATION bin/resources OPTIONAL)
install(DIRECTORY "$<TARGET_FILE_DIR:${PROJECT_NAME}>/translations/" DESTINATION bin/translations OPTIONAL)

# Install frontend
install(DIRECTORY ../frontend/ DESTINATION share/${PROJECT_NAME}/frontend)

message(STATUS "DiskRaptor ${PROJECT_VERSION} — Qt ${Qt6_VERSION}")
