# DiskRaptor Qt 6 + QtWebEngine
cmake_minimum_required(VERSION 3.20)
project(DiskRaptor VERSION 0.2.6 DESCRIPTION "Ultra-fast disk space analyzer" LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets WebEngineWidgets WebChannel Network)

set(SOURCES src/main.cpp src/webviewwindow.cpp src/ipcbridge.cpp src/scanner.cpp src/platform_utils.cpp)
set(HEADERS src/webviewwindow.h src/ipcbridge.h src/scanner.h src/platform_utils.h)
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

# Copy frontend after build
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../frontend" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/frontend")

# Install
install(TARGETS ${PROJECT_NAME} RUNTIME DESTINATION bin)
install(DIRECTORY ../frontend/ DESTINATION share/${PROJECT_NAME}/frontend)

# CPack for MSI
set(CPACK_PACKAGE_NAME "DiskRaptor")
set(CPACK_PACKAGE_VERSION "${PROJECT_VERSION}")
set(CPACK_PACKAGE_VENDOR "DiskRaptor Team")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Ultra-fast disk space analyzer")

if(WIN32)
  set(CPACK_GENERATOR "WIX")
  set(CPACK_WIX_UPGRADE_GUID "8A2E5B3C-9D4F-4E6B-8C7D-1F2A3B4C5D6E")
  set(CPACK_WIX_PRODUCT_GUID "1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D")
  set(CPACK_WIX_LANG "en-US")
  set(CPACK_PACKAGE_FILE_NAME "DiskRaptor_${PROJECT_VERSION}_x64_Qt")
elseif(UNIX AND NOT APPLE)
  set(CPACK_GENERATOR "DEB;TGZ")
  set(CPACK_DEBIAN_PACKAGE_MAINTAINER "DiskRaptor Team")
endif()

include(CPack)

message(STATUS "DiskRaptor ${PROJECT_VERSION} — Qt ${Qt6_VERSION}")
