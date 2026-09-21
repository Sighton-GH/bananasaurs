import type {
  GenerateTextRequest,
  GenerateTextResponse,
  ProviderCapability,
  TextProvider,
} from './contracts.js';
import { assertOutboundRequestSafe } from './outbound-safety.js';
import { assertSpendAllowed, type ProviderCostClass, type SpendPolicy } from './spend-policy.js';

/** Mandatory composition boundary: local checks run before the provider is called. */
export class SafeProvider implements TextProvider {
  public readonly id: string;
  public readonly capabilities: ReadonlySet<ProviderCapability>;
  public constructor(
    private readonly inner: TextProvider,
    private readonly costClass: ProviderCostClass,
    private readonly spendPolicy: SpendPolicy,
  ) {
    this.id = inner.id;
    this.capabilities = inner.capabilities;
  }
  public async generateText(request: GenerateTextRequest): Promise<GenerateTextResponse> {
    assertSpendAllowed(this.spendPolicy, this.costClass);
    assertOutboundRequestSafe(request);
    return await this.inner.generateText(request);
  }
}
