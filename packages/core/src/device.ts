export const DEVICE_TYPES = ['mobile', 'desktop'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const DEVICE_SIZE: Record<DeviceType, { w: number; h: number }> = {
  mobile: { w: 390, h: 844 },
  desktop: { w: 1280, h: 800 },
};
