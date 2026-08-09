.PHONY: build test unit e2e app clean

build:
	swift build

test:
	swift test

# Fast inner-loop tests (no process spawning).
unit:
	swift test --filter DomoProtocolTests --filter DomoDeviceCoreTests

# Full-stack tests: real broker + device processes + MCP client.
e2e: build
	swift test --filter DomoE2ETests

app:
	swift build --product DomoApp

clean:
	swift package clean
	rm -rf .build
