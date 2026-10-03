import type { WorkstationId } from "../shared/ids";
import type { RuntimeCapabilitiesDto } from "../runtime/runtime";

export interface NodeHandshakeDto {
  readonly protocolVersion: { readonly major: number; readonly minor: number };
  readonly nodeId: string;
  readonly instanceId: string;
  readonly workstationId: WorkstationId;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly runtimeCapabilities: readonly RuntimeCapabilitiesDto[];
  readonly lastAcknowledgedCommand?: string;
}
