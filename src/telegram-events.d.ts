/**
 * Ambient module declaration for 'telegram/events'.
 *
 * The 'telegram' package does not include an "exports" map in its package.json,
 * so TypeScript with `moduleResolution: NodeNext` cannot resolve subpath
 * imports like `telegram/events`.  This declaration re-exports the types that
 * the project actually uses so that both `typeof import('telegram/events')`
 * and the runtime dynamic `import('telegram/events')` resolve correctly.
 */
declare module 'telegram/events' {
  export { NewMessage, NewMessageEvent } from 'telegram/events/NewMessage.js'
}
