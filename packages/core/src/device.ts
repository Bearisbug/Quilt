export const DEVICE_TYPES = ['mobile', 'desktop'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

// 呈现方式（v0.63 REQ-PROTO-005）：push 整屏换 / overlay 压在当前屏上（弹层、底部抽屉）；是屏的元数据，不进修订
export const PRESENTATIONS = ['push', 'overlay'] as const;
export type Presentation = (typeof PRESENTATIONS)[number];

export const DEVICE_SIZE: Record<DeviceType, { w: number; h: number }> = {
  mobile: { w: 390, h: 844 },
  desktop: { w: 1280, h: 800 },
};
