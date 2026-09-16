import { SQL } from 'bun';
export type SqlClient = Pick<SQL, 'unsafe'> & ((strings: TemplateStringsArray, ...values: any[]) => any);
export function createDb(url: string) { return new SQL(url, { max: 10, idleTimeout: 20, connectionTimeout: 5 }); }
