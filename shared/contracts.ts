export type Role = 'admin' | 'user';
export type UserStatus = 'pending' | 'active' | 'disabled';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
}
export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface ApiResponse<T> { data: T; meta?: { total: number; page: number; limit: number } }
export interface ApiError { error: { code: string; message: string; fields?: Record<string, string> }; requestId: string }
export interface SessionData { user: User; csrfToken: string }
