/** JSON-serializable values (everything stored in project and view files). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
