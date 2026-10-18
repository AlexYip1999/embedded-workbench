export interface BoardHint {
  chip: string;
  flashMb?: number;
  note?: string;
}

const HINTS: Record<string, BoardHint> = {
  nodemcuv2: { chip: "ESP8266", flashMb: 4, note: "NodeMCU 1.0 / ESP-12E" },
  d1_mini: { chip: "ESP8266", flashMb: 4, note: "Wemos D1 mini" },
  esp01_1m: { chip: "ESP8266", flashMb: 1, note: "ESP-01S 1MB" },
  esp01: { chip: "ESP8266", flashMb: 1, note: "ESP-01" },
  esp8285: { chip: "ESP8266", flashMb: 1, note: "ESP8285" },
  esp32dev: { chip: "ESP32", flashMb: 4 },
  "esp32-c3-devkitm-1": { chip: "ESP32-C3", flashMb: 4 },
  "esp32-s3-devkitc-1": { chip: "ESP32-S3", flashMb: 8 },
  esp32cam: { chip: "ESP32", flashMb: 4 },
};

export function boardHint(id?: string): BoardHint | undefined {
  if (!id) return undefined;
  return HINTS[id.toLowerCase()];
}
