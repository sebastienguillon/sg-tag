Put platform-specific `ffmpeg` and `ffprobe` executables in `mac/`, `win/` or `linux/`. They are
bundled into the packaged app as `resources/bin/` and preferred over the ones on the PATH.

Pick LGPL builds if the app is ever distributed. In development, any ffmpeg on the PATH is used.
