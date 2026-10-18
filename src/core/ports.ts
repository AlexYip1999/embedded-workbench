import { PioContext, runPio } from "./pio";

export interface SerialDevice {
  port: string;
  description: string;
  hwid: string;
  vid?: string;
  pid?: string;
  chip?: string;
}

export interface DeviceListing {
  serial: SerialDevice[];
  error?: string;
  scannedAt: string;
}

/** Common USB-serial chips used on ESP8266/ESP32 dev boards. */
const USB_CHIPS: Record<string, string> = {
  "1a86:7523": "CH340 / CH341（USB 转串口）",
  "1a86:5523": "CH341A",
  "1a86:7522": "CH340K",
  "1a86:7524": "CH341",
  "1a86:55d4": "CH9102 / CH9102F（USB 转串口）",
  "10c4:ea60": "CP2102 / CP2104（Silicon Labs）",
  "10c4:ea70": "CP2105（Silicon Labs）",
  "10c4:ea71": "CP2108（Silicon Labs）",
  "0403:6001": "FT232R（FTDI）",
  "0403:6010": "FT2232（FTDI）",
  "0403:6015": "FT231X（FTDI）",
  "2341:0001": "Arduino（官方）",
  "2341:0043": "Arduino Uno",
  "2e8a:0005": "RP2040 / Raspberry Pi Pico",
  "303a:1001": "ESP32-S3 内置 USB-JTAG",
  "303a:0002": "ESP32-S2 内置 USB",
};

const USB_VENDORS: Record<string, string> = {
  "1a86": "WCH（沁恒）USB 转串口",
  "10c4": "Silicon Labs USB 转串口",
  "0403": "FTDI USB 转串口",
  "2341": "Arduino",
  "2e8a": "Raspberry Pi（RP2040）",
  "303a": "Espressif 芯片内置 USB",
};

export function parseVidPid(hwid?: string): { vid?: string; pid?: string } {
  const m = /VID:PID=([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})/.exec(hwid ?? "");
  return m ? { vid: m[1].toUpperCase(), pid: m[2].toUpperCase() } : {};
}

export function chipFromHwid(hwid?: string): string | undefined {
  const { vid, pid } = parseVidPid(hwid);
  if (!vid || !pid) return undefined;
  const known = USB_CHIPS[`${vid.toLowerCase()}:${pid.toLowerCase()}`];
  if (known) return known;
  return USB_VENDORS[vid.toLowerCase()];
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { serial?: unknown[] }).serial)) {
    return (value as { serial: unknown[] }).serial;
  }
  return [];
}

export async function scanSerialDevices(ctx: PioContext): Promise<DeviceListing> {
  const scannedAt = new Date().toLocaleTimeString();
  const res = await runPio(ctx, ["device", "list", "--json-output"], 20000);
  if (res.code !== 0) {
    const message = (res.stderr || res.stdout).trim() || `pio device list 退出码 ${res.code}`;
    return { serial: [], error: message, scannedAt };
  }

  try {
    const data = JSON.parse(res.stdout.trim() || "[]") as unknown;
    const serial: SerialDevice[] = [];
    for (const raw of asArray(data)) {
      const record = raw as Record<string, unknown>;
      const port = String(record.port ?? "");
      if (!port) continue;
      const hwid = String(record.hwid ?? "");
      const { vid, pid } = parseVidPid(hwid);
      serial.push({
        port,
        description: String(record.description ?? ""),
        hwid,
        vid,
        pid,
        chip: chipFromHwid(hwid),
      });
    }
    serial.sort((a, b) => a.port.localeCompare(b.port));
    return { serial, scannedAt };
  } catch {
    return { serial: [], error: "无法解析 pio device list 的 JSON 输出", scannedAt };
  }
}
