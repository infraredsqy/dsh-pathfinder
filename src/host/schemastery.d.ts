/**
 * `@deepseek-ai/schemastery` 的最小声明。
 *
 * 那份包由宿主提供，本仓不装它、也不摆抄本：DSH 的设置服务拿它自己那份 schemastery 去重建
 * 我们交出去的 schema（两边流通的就是这一副 JSON 形状），这里只声明运行时用得上的那几手。
 */
declare module '@deepseek-ai/schemastery' {
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
    default(value: T): Schema<T>
    min(value: number): Schema<T>
    max(value: number): Schema<T>
  }

  export interface Schemastery {
    /** 照一份序列化过的形状重建一个节点。 */
    <T>(json: unknown): Schema<T>
    object(dict: Readonly<Record<string, Schema>>): Schema<Record<string, unknown>>
    boolean(): Schema<boolean>
    number(): Schema<number>
    /** 取值只在这几个词里。 */
    union(values: readonly string[]): Schema<string>
  }

  const schemastery: Schemastery
  export default schemastery
}