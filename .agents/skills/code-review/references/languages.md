# Language-Specific Code Review Guidelines

## TypeScript

### Type Safety
- [ ] Proper type definitions (avoid `any`)
- [ ] Interfaces for complex objects
- [ ] Enums for fixed sets of values
- [ ] Null checks with strictNullChecks enabled
- [ ] No type assertions without validation

### React Patterns
- [ ] Proper hook dependencies in useEffect
- [ ] Cleanup functions for subscriptions
- [ ] Memoization where appropriate (useMemo, useCallback)
- [ ] Proper error boundaries

### Node.js Patterns
- [ ] Async/await over callbacks
- [ ] Proper stream handling
- [ ] Environment variable validation
- [ ] Graceful shutdown handling

## Python

### Type Hints
- [ ] Type hints on function parameters and returns
- [ ] Use of Optional for nullable values
- [ ] Generic types for collections

### Patterns
- [ ] Docstrings for public functions
- [ ] Context managers for resources
- [ ] List comprehensions where appropriate
- [ ] No mutable default arguments

### Common Issues
- [ ] Avoid bare `except:` clauses
- [ ] Use `is` for None comparison
- [ ] Proper virtual environment usage
- [ ] Requirements pinned to versions

## SQL

### Query Safety
- [ ] USE statement at start for multi-DB servers
- [ ] Parameterized queries (no string concatenation)
- [ ] Proper NULL handling (IS NULL, COALESCE)
- [ ] Transaction handling for multiple operations

### Performance
- [ ] Proper JOINs (avoid cartesian products)
- [ ] WHERE clause optimization (indexed columns first)
- [ ] Avoid SELECT * in production
- [ ] LIMIT/TOP for large result sets

### MSSQL Specific
- [ ] NOLOCK hints only where appropriate
- [ ] Proper identity column handling
- [ ] Clustered index considerations

## C#

### Async Patterns
- [ ] Proper async/await usage (no async void)
- [ ] ConfigureAwait(false) in libraries
- [ ] Cancellation token propagation

### Resource Management
- [ ] IDisposable implemented where needed
- [ ] Using statements for disposables
- [ ] Proper garbage collection hints

### Modern C# Features
- [ ] Null-conditional operators (?.)
- [ ] Pattern matching where appropriate
- [ ] LINQ used efficiently
- [ ] Records for immutable data

### Exception Handling
- [ ] Specific exception types caught
- [ ] Exception hierarchy respected
- [ ] Proper exception message context
