cmake_minimum_required(VERSION 3.20)
project(DiskRaptor VERSION 1.0.7 DESCRIPTION "Ultra-fast disk space analyzer" LANGUAGES CXX)
if(APPLE)
  enable_language(OBJCXX)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

if(APPLE)
  find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets Network)
else()
  find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets WebEngineWidgets WebChannel Network)
endif()

set(SOURCES
  src/main.cpp
  src/webviewwindow.cpp
  src/ipcbridge.cpp
  src/platform_utils.cpp
  src/modules/module_loader.cpp
  src/commands/file_ops.cpp
  src/commands/system.cpp
  src/commands/settings.cpp
  src/commands/scanner.cpp
  src/cdp_server.cpp)
if(APPLE)
  list(APPEND SOURCES src/wkwebview_wrapper.mm)
else()
  list(APPEND SOURCES src/wkwebview_wrapper.cpp)
endif()
set(HEADERS
  src/webviewwindow.h
  src/ipcbridge.h
  src/platform_utils.h
  src/modules/module_loader.h
  src/commands/file_ops.h
  src/commands/system.h
  src/commands/settings.h
  src/commands/scanner.h
  src/cdp_server.h
  src/wkwebview_wrapper.h)
set(RESOURCES resources/resources.qrc)

if(WIN32)
  set(APP_ICON_PATH "${CMAKE_SOURCE_DIR}/../images/icon.ico")
  configure_file(resources/windows/app.rc.in ${CMAKE_BINARY_DIR}/app-icon.rc @ONLY)
  configure_file(resources/windows/launcher.rc.in ${CMAKE_BINARY_DIR}/launcher-icon.rc @ONLY)
  list(APPEND SOURCES ${CMAKE_BINARY_DIR}/app-icon.rc)
elseif(UNIX AND NOT APPLE)
  configure_file(resources/linux/DiskRaptor.desktop.in ${CMAKE_BINARY_DIR}/diskraptor.desktop @ONLY)
endif()

add_executable(${PROJECT_NAME} ${SOURCES} ${HEADERS} ${RESOURCES})

target_link_libraries(${PROJECT_NAME} PRIVATE
  Qt6::Core Qt6::Gui Qt6::Widgets Qt6::Network
  ${CMAKE_DL_LIBS})
if(NOT APPLE)
  target_link_libraries(${PROJECT_NAME} PRIVATE
    Qt6::WebEngineWidgets Qt6::WebChannel)
endif()

if(APPLE)
  target_link_libraries(${PROJECT_NAME} PRIVATE
    "-framework WebKit"
    "-framework Cocoa")
endif()

target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)

if(WIN32)
  set_target_properties(${PROJECT_NAME} PROPERTIES WIN32_EXECUTABLE TRUE)
  target_compile_definitions(${PROJECT_NAME} PRIVATE PLATFORM_WINDOWS)
elseif(UNIX AND NOT APPLE)
  target_compile_definitions(${PROJECT_NAME} PRIVATE PLATFORM_LINUX)
elseif(APPLE)
  set_target_properties(${PROJECT_NAME} PROPERTIES
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_GUI_IDENTIFIER "diskraptor"
    MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
    MACOSX_BUNDLE_ICON_FILE "icon.icns")
  add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy "${CMAKE_SOURCE_DIR}/../images/icon.icns"
      "$<TARGET_FILE_DIR:${PROJECT_NAME}>/../Resources/icon.icns"
    COMMENT "Copying icon.icns into app bundle...")
endif()

add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../frontend" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/frontend")
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../modulesPro" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/modulesPro")
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../images" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/images")

if(WIN32)
  set(RUST_SCANNER_SRC "${CMAKE_SOURCE_DIR}/../src-tauri/target/release/diskraptor_scanner.dll")
  set(RUST_SCANNER_DST "diskraptor_scanner.dll")
elseif(APPLE)
  set(RUST_SCANNER_SRC "${CMAKE_SOURCE_DIR}/../src-tauri/target/release/libdiskraptor_scanner.dylib")
  set(RUST_SCANNER_DST "libdiskraptor_scanner.dylib")
else()
  set(RUST_SCANNER_SRC "${CMAKE_SOURCE_DIR}/../src-tauri/target/release/libdiskraptor_scanner.so")
  set(RUST_SCANNER_DST "libdiskraptor_scanner.so")
endif()

if(EXISTS "${RUST_SCANNER_SRC}")
  add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy "${RUST_SCANNER_SRC}" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/${RUST_SCANNER_DST}"
    COMMENT "Copying ${RUST_SCANNER_DST}...")
  message(STATUS "Rust scanner library will be deployed: ${RUST_SCANNER_SRC}")
else()
  message(WARNING "Rust scanner library not found at ${RUST_SCANNER_SRC} — tree scan will fall back to flat mode")
endif()

if(WIN32)
  find_program(WINDEPLOYQT_EXECUTABLE
    NAMES windeployqt.exe
    HINTS "$ENV{QT_QMAKE_DIR}" "$ENV{QTDIR}/bin" "${Qt6_DIR}/../../../bin"
    DOC "Path to windeployqt.exe")
  if(WINDEPLOYQT_EXECUTABLE)
    message(STATUS "windeployqt: ${WINDEPLOYQT_EXECUTABLE}")
    add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
      COMMAND ${WINDEPLOYQT_EXECUTABLE}
        --release
        --no-translations
        --no-opengl-sw
        --no-system-d3d-compiler
        --no-compiler-runtime
        "$<TARGET_FILE:${PROJECT_NAME}>"
      COMMENT "windeployqt: deploy Qt runtime DLLs"
      VERBATIM)
  else()
    message(WARNING "windeployqt.exe not found — Qt6 runtime DLLs will NOT be deployed to the build output.\n"
      "  Install Qt or add Qt6/bin to PATH, then re-run cmake.")
  endif()
endif()

if(WIN32)
  add_executable(DiskRaptorLauncher WIN32 src/launcher.cpp ${CMAKE_BINARY_DIR}/launcher-icon.rc)
  target_link_libraries(DiskRaptorLauncher PRIVATE
    kernel32 user32 shell32 wininet)
  set_target_properties(DiskRaptorLauncher PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "$<TARGET_FILE_DIR:${PROJECT_NAME}>")
  install(TARGETS DiskRaptorLauncher RUNTIME DESTINATION bin)
endif()

install(TARGETS ${PROJECT_NAME}
  RUNTIME DESTINATION bin
  BUNDLE DESTINATION bin)

if(WIN32)
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

install(DIRECTORY ../frontend/ DESTINATION share/${PROJECT_NAME}/frontend)

if(UNIX AND NOT APPLE)
  install(FILES ${CMAKE_BINARY_DIR}/diskraptor.desktop DESTINATION share/applications)
  install(FILES ${CMAKE_SOURCE_DIR}/../images/128x128@2x.png DESTINATION share/icons/hicolor/128x128/apps RENAME diskraptor.png)
endif()

set(CPACK_PACKAGE_NAME "DiskRaptor")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_FILE_NAME "DiskRaptor-${PROJECT_VERSION}-linux-amd64")
set(CPACK_DEBIAN_PACKAGE_MAINTAINER "DiskRaptor Team")
include(CPack)

message(STATUS "DiskRaptor ${PROJECT_VERSION}")
