/**
 * `@deepseek-ai/schemastery` 的最小声明。
 *
 * 那份包由宿主提供（本仓把它列在 `peerDependencies` 里），本仓自己不装它，也不摆一份
 * 抄本：DSH 的设置服务拿**它自己那份** schemastery 去重建我们交出去的 schema
 * （`new z(schema.toJSON())`）。两边之间流通的就是这一副 JSON 形状，照着它重建，
 * 两份包因此用不着共用同一份对象。
 *
 * 运行时用得上的只有建节点这一件事（`src/host/config.ts`），所以这里只声明那几手：
 * 建节点、标 volatile、给默认值、量上下限，以及交出去时那个 `toJSON`。
 */
declare module '@deepseek-ai/schemastery' {
  /** 一份 schema 节点。 */
  export interface Schema<T = unknown> {
    /** 拿一个原始值过一遍这一份 schema。 */
    (value: unknown): T
    /** 节点种类；设置服务照它分对象与字段。 */
    readonly type: string
    /** 节点自己那点记号：`volatile` 说的就是「设置页里看不看得见这一条」。 */
    readonly meta: { volatile?: boolean; default?: unknown }
    /** 对象节点的字段表。 */
    readonly dict: Readonly<Record<string, Schema>> | undefined
    /** 交给设置服务的那一副形状。 */
    toJSON(): unknown
    /** 标成可以在设置页里现改。 */
    volatile(): Schema<T>
    /** 出厂默认。 */
    default(value: T): Schema<T>
    /** 数值下限。 */
    min(value: number): Schema<T>
    /** 数值上限。 */
    max(value: number): Schema<T>
  }

  /** 这一份包的入口。 */
  export interface Schemastery {
    /** 照一份序列化过的形状重建一个节点。 */
    <T>(json: unknown): Schema<T>
    /** 一个对象节点。 */
    object(dict: Readonly<Record<string, Schema>>): Schema<Record<string, unknown>>
    /** 一个布尔节点。 */
    boolean(): Schema<boolean>
    /** 一个数值节点。 */
    number(): Schema<number>
    /** 一个枚举节点：取值只在这几个词里。 */
    union(values: readonly string[]): Schema<string>
  }

  const schemastery: Schemastery
  export default schemastery
}