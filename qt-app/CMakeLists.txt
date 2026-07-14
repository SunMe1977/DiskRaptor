# DiskRaptor Qt 6 + QtWebEngine
cmake_minimum_required(VERSION 3.20)
project(DiskRaptor VERSION 0.2.8 DESCRIPTION "Ultra-fast disk space analyzer â€” Qt 6 Edition" LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets WebEngineWidgets WebChannel Network)

set(SOURCES src/main.cpp src/webviewwindow.cpp src/ipcbridge.cpp src/scanner.cpp src/platform_utils.cpp src/modules/module_loader.cpp)
set(HEADERS src/webviewwindow.h src/ipcbridge.h src/scanner.h src/platform_utils.h src/modules/module_loader.h)
set(RESOURCES resources/resources.qrc)

if(WIN32)
  set(APP_ICON_PATH "${CMAKE_SOURCE_DIR}/../images/icon.ico")
  configure_file(resources/windows/app.rc.in ${CMAKE_BINARY_DIR}/app-icon.rc @ONLY)
  configure_file(resources/windows/launcher.rc.in ${CMAKE_BINARY_DIR}/launcher-icon.rc @ONLY)
  list(APPEND SOURCES ${CMAKE_BINARY_DIR}/app-icon.rc)
endif()

add_executable(${PROJECT_NAME} ${SOURCES} ${HEADERS} ${RESOURCES})

target_link_libraries(${PROJECT_NAME} PRIVATE
  Qt6::Core Qt6::Gui Qt6::Widgets Qt6::WebEngineWidgets Qt6::WebChannel Qt6::Network
  ${CMAKE_DL_LIBS})

target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

if(WIN32)
  set_target_properties(${PROJECT_NAME} PROPERTIES WIN32_EXECUTABLE TRUE)
  target_compile_definitions(${PROJECT_NAME} PRIVATE PLATFORM_WINDOWS)
elseif(UNIX AND NOT APPLE)
  target_compile_definitions(${PROJECT_NAME} PRIVATE PLATFORM_LINUX)
elseif(APPLE)
  set_target_properties(${PROJECT_NAME} PROPERTIES
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.diskraptor.app"
    MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}")
endif()

# Copy frontend + modules after build
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../frontend" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/frontend")
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../modulesPro" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/modulesPro")

# â”€â”€ Launcher (no Qt deps, Win32 only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if(WIN32)
  add_executable(DiskRaptorLauncher WIN32 src/launcher.cpp ${CMAKE_BINARY_DIR}/launcher-icon.rc)
  target_link_libraries(DiskRaptorLauncher PRIVATE
    kernel32 user32 shell32 wininet)
  set_target_properties(DiskRaptorLauncher PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "$<TARGET_FILE_DIR:${PROJECT_NAME}>")
  install(TARGETS DiskRaptorLauncher RUNTIME DESTINATION bin)
endif()

# â”€â”€ Install â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Install core binary - platform agnostic
install(TARGETS ${PROJECT_NAME}
  RUNTIME DESTINATION bin
  BUNDLE DESTINATION bin)

if(WIN32)
  # Install core DLLs (windeployqt output) â€” exclude WebEngine + avoid recursion
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
      PATTERN "install" EXCLUDE
      PATTERN "build_*" EXCLUDE
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
endif()

# Install frontend
install(DIRECTORY ../frontend/ DESTINATION share/${PROJECT_NAME}/frontend)

# â”€â”€ CPack â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# IMPORTANT: set CPack variables BEFORE include(CPack) â€” CPack reads them at include time
set(CPACK_PACKAGE_NAME "DiskRaptor")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_FILE_NAME "DiskRaptor_${PROJECT_VERSION}_amd64")
set(CPACK_DEBIAN_PACKAGE_MAINTAINER "DiskRaptor Team")
include(CPack)

message(STATUS "DiskRaptor ${PROJECT_VERSION} â€” Qt ${Qt6_VERSION}")
