# Builds with the Command Line Tools alone. SwiftPM and Xcode aren't needed:
# swiftc compiles the shell and the bundle is put together by hand.
APP = build/Beetle Desktop.app
CONTENTS = $(APP)/Contents

.PHONY: app run dev check clean

app: build/Beetle.icns
	@mkdir -p "$(CONTENTS)/MacOS" "$(CONTENTS)/Resources"
	@swiftc -O -target arm64-apple-macosx13.0 shell/main.swift -o "$(CONTENTS)/MacOS/Beetle"
	@cp shell/Info.plist "$(CONTENTS)/Info.plist"
	@cp build/Beetle.icns assets/menubar.svg "$(CONTENTS)/Resources/"
	@rm -rf "$(CONTENTS)/Resources/web" && cp -R web "$(CONTENTS)/Resources/web"
	@codesign --force --sign - "$(APP)" 2>/dev/null
	@echo "  $(APP)"

build/Beetle.icns: assets/icon.png
	@rm -rf build/Beetle.iconset && mkdir -p build/Beetle.iconset
	@for s in 16 32 128 256 512; do \
		sips -z $$s $$s assets/icon.png --out build/Beetle.iconset/icon_$${s}x$${s}.png >/dev/null; \
		d=$$((s * 2)); sips -z $$d $$d assets/icon.png --out build/Beetle.iconset/icon_$${s}x$${s}@2x.png >/dev/null; \
	done
	@iconutil -c icns build/Beetle.iconset -o $@

run: app
	@open "$(APP)"

# Pages load from web/ here, so an edit needs only Command-R, and Safari's
# Develop menu can inspect the window. Only a change to shell/ needs a build.
dev: app
	@BEETLE_WEB=$(CURDIR)/web "$(CONTENTS)/MacOS/Beetle"

# The page in the app's own web view, written to a file.
check: app
	@"$(CONTENTS)/MacOS/Beetle" --snapshot build/snapshot.png
	@test -s build/snapshot.png && echo "  build/snapshot.png"

clean:
	@rm -rf build
