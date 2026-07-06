export type GatewayPostReadySidecarHandle = {
  stop: () => void | Promise<void>;
};

export type GatewaySidecarStartupMode = "start" | "defer";
