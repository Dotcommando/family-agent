import type { IIntegration } from '../integrations/types.js'
import type { EventBus } from '../queue/event-bus.js'
import type { EventQueue } from '../queue/event-queue.js'
import type { IEnvConfig } from '../config/env.js'
import type { IAppSecrets } from '../config/types.js'

export interface IRuntimeContext {
  config: IEnvConfig
  secrets: IAppSecrets
  eventBus: EventBus
  eventQueue: EventQueue
  integrations: ReadonlyArray<IIntegration>
}
