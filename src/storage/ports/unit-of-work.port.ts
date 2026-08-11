export interface UnitOfWorkPort {
  transaction<T>(work: () => Promise<T>, settings?: readonly string[]): Promise<T>;
}
