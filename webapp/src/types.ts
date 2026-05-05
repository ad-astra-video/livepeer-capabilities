export interface GPUComputeInfo {
  id: string;
  name: string;
  major: number;
  memory_free: number;
  memory_total: number;
}

export interface HardwareInformation {
  pipeline: string;
  model_id: string;
  gpu_info: Record<string, GPUComputeInfo>;
}

export interface CapabilityPrice {
  pricePerUnit: number;
  pixelsPerUnit: number;
  capability: number;
  constraint: string;
}

export interface Capabilities {
  bitstring: number[];
  capacities: Record<string, number>;
  version: string;
  constraints?: {
    minVersion?: string;
    PerCapability?: Record<string, {
      models?: Record<string, {
        warm?: boolean;
        runnerVersion?: string;
        capacityInUse?: number;
      }>;
    }>;
  };
}

export interface Orchestrator {
  address: string;
  local_address: string;
  orch_uri: string;
  capabilities: Capabilities;
  capabilities_prices: CapabilityPrice[] | null;
  hardware: HardwareInformation[] | null;
  regions: string[];
}

export interface NetworkCapabilities {
  capabilities_names: Record<string, string>;
  orchestrators: Orchestrator[] | null;
}

export interface GatewayService {
  name: string;
  url: string;
  data: NetworkCapabilities | null;
  loading: boolean;
  error: string | null;
}
