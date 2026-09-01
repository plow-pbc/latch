{
  "targets": [
    {
      "target_name": "credential_import",
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/credentialImport.mm"],
          "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
          "defines": ["NAPI_VERSION=8"],
          "libraries": ["-framework Foundation"],
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
