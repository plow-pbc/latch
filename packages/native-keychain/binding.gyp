{
  "targets": [
    {
      "target_name": "keychain",
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/keychain.mm"],
          "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
          "defines": ["NAPI_VERSION=8"],
          "libraries": ["-framework Security", "-framework CoreFoundation"],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "OTHER_CFLAGS": ["-fexceptions", "-arch", "arm64", "-arch", "x86_64"],
            "OTHER_LDFLAGS": ["-arch", "arm64", "-arch", "x86_64"]
          }
        }],
        ["OS!='mac'", {
          "sources": []
        }]
      ]
    }
  ]
}
