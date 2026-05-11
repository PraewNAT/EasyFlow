# EasyFlow

Figma plugin สำหรับวาด flow diagram ระหว่าง Frame/Group/Component ใน Figma แบบรวดเร็ว
ปรับ style เส้น (สี, opacity, stroke, dashed, radius), หัว/ท้ายลูกศร 5 แบบ,
ตำแหน่ง anchor 4 ด้าน + auto, และ label ที่จัดกลางเส้นพร้อม typography control ครบชุด

## โครงสร้างโปรเจกต์

```
EasyFlow_Plugin/
├── manifest.json       # Figma plugin manifest
├── package.json        # npm scripts + dev deps (esbuild, @figma/plugin-typings)
├── tsconfig.json       # TypeScript config
├── build.js            # esbuild bundler + ui.html copier
├── src/
│   ├── code.ts         # Plugin sandbox (Figma API)
│   ├── geometry.ts     # Pure path/anchor geometry helpers
│   ├── types.ts        # Shared types & defaults
│   └── ui.html         # Plugin UI (368 × 640) — self-contained HTML/CSS/JS
├── icon/               # Material Symbols SVG icons
└── dist/               # build output (code.js, ui.html)
```

## การติดตั้งและบิวด์

```bash
cd EasyFlow_Plugin
npm install
npm run build      # build production bundle ลง dist/
npm run watch      # rebuild อัตโนมัติเมื่อแก้ไฟล์
npm run typecheck  # ตรวจสอบ type อย่างเดียว
```

## วิธีโหลดเข้า Figma

1. เปิด Figma desktop → Plugins → Development → **Import plugin from manifest…**
2. เลือกไฟล์ `manifest.json` ในโฟลเดอร์นี้
3. รัน plugin ผ่านเมนู Plugins → Development → EasyFlow

## การใช้งาน

| สถานการณ์ที่ select | สิ่งที่ปลั๊กอินทำ |
| --- | --- |
| 2 frames/groups | ปุ่ม **Connect selected frames** สร้างเส้น flow ระหว่างสองชิ้น |
| 1 flow line ที่มีอยู่ | UI sync style ทั้งหมด, เปลี่ยนค่าแล้วเส้นอัปเดตทันที |
| หลาย flow lines | apply style เดียวกันกับทุกเส้น |
| ไม่มี selection / mixed | ปุ่ม disable, footer อธิบายต้องทำอะไรต่อ |

- **Toggle Off** → ปลั๊กอินไม่สร้าง/อัปเดตเส้นใดๆ (ยังเปิด UI ได้แต่ disable การโต้ตอบ)
- **Swap** → สลับต้น↔ปลายของเส้น (รวม anchor + arrow)
- **Anchor dots** → คลิก dot บน frame Start/End เพื่อ pin ด้าน (คลิกซ้ำ = กลับ auto)
- **Document change** → เมื่อ frame ต้นทาง/ปลายทางถูกย้าย/resize, เส้นจะ re-route อัตโนมัติ

## Data model

แต่ละ flow ถูกเก็บเป็น `FrameNode` แบบโปร่งใส (fills = []) ที่ pluginData
key `easyflow.meta` เก็บ JSON ของ `FlowMeta` (`fromNodeId`, `toNodeId` + style
ทั้งหมด). children ของ frame นี้ประกอบด้วย:

- `line` — vector path (step หรือ bezier)
- `cap-arrow` / `cap-circle` / `cap-diamond` / `cap-square` — หัวลูกศร
- `label` — text node กึ่งกลางเส้น

ดู `src/types.ts` สำหรับ schema เต็ม

## Future work

- Smart routing (หลบ object จริงๆ)
- Preset styles (Success / Error / Default)
- 1 → many connections
- Export flow map
- Animation preview
# EasyFlow
