interface PaginatedConnection {
  pageInfo?: { hasNextPage?: boolean };
  fetchNext?: () => Promise<unknown>;
}

/** Fully drains a Linear SDK connection before its nodes are consumed. */
export async function drainConnection<T extends PaginatedConnection>(connection: T): Promise<T> {
  while (connection.pageInfo?.hasNextPage) {
    if (!connection.fetchNext) {
      throw new Error('Linear returned a paginated connection without fetchNext().');
    }
    await connection.fetchNext();
  }
  return connection;
}
