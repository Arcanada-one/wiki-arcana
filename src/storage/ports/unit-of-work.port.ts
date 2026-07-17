export interface UnitOfWorkPort {
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

