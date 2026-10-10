# bmpstats.py <file.bmp>: distinct colours and the share of the page-grey (#484955) background.
import struct, sys
data = open(sys.argv[1], 'rb').read()
offset = struct.unpack_from('<I', data, 10)[0]
width, height = struct.unpack_from('<ii', data, 18)
bpp = struct.unpack_from('<H', data, 28)[0]
height = abs(height)
step = bpp // 8
row = (width * step + 3) & ~3
colours, grey, total = set(), 0, 0
for y in range(0, height, 2):
    base = offset + y * row
    for x in range(0, width, 2):
        b, g, r = data[base + x * step: base + x * step + 3]
        colours.add((r >> 3, g >> 3, b >> 3))
        if abs(r - 0x48) < 6 and abs(g - 0x49) < 6 and abs(b - 0x55) < 6:
            grey += 1
        total += 1
print(f"window {width}x{height}: {len(colours)} distinct colours, {100.0 * grey / max(total, 1):.1f}% background grey")
