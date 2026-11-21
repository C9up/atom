# Link atom's Rust engine and its JSI module into a React Native app's native
# library (`appmodules`). `ream android:*` does this for an app from atom's
# `reamNative` declaration (package.json): it builds crates/atom-ffi into
# REAM_RUST_DIR/<abi>/libatom_ffi.a, includes this file, calls atom_link and
# registers NativeAtom in the app's module provider. The spec it generates the
# C++ base class from is specs/NativeAtom.ts.

set(ATOM_ANDROID_DIR ${CMAKE_CURRENT_LIST_DIR})

if(DEFINED REAM_RUST_DIR)
  set(ATOM_FFI_LIB ${REAM_RUST_DIR}/${ANDROID_ABI}/libatom_ffi.a)
else()
  set(ATOM_FFI_LIB ${ATOM_ANDROID_DIR}/libs/${ANDROID_ABI}/libatom_ffi.a)
endif()

function(atom_link target)
  target_sources(${target} PRIVATE ${ATOM_ANDROID_DIR}/src/main/cpp/NativeAtom.cpp)
  target_include_directories(${target} PUBLIC ${ATOM_ANDROID_DIR}/src/main/cpp)
  add_library(atom_ffi STATIC IMPORTED)
  set_target_properties(atom_ffi PROPERTIES IMPORTED_LOCATION ${ATOM_FFI_LIB})
  target_link_libraries(${target} atom_ffi)
endfunction()
