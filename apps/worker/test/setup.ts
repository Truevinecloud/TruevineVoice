import 'reflect-metadata';

/**
 * Global test setup.
 *
 * NestJS decorators call `Reflect.defineMetadata` while the module under test
 * is being evaluated, so `reflect-metadata` has to be loaded before any test
 * file is imported. Setup files run before test collection, which makes this the
 * right place for it.
 */
