# API Deprecations & Removals

This document tracks significant internal API removals and changes that affect programmatic usage or internal abstractions.

## Links Helpers Re-export Removal

**Date**: 2024 (Issue #502)

**Removed Path**: `bwrb/dist/lib/audit/types.js` (exported link helpers)  
**New Path**: `bwrb/dist/lib/links.js`

### Details
Previously, several shared link utilities were re-exported from `src/lib/audit/types.ts` for backward compatibility. These re-exports have been deleted.

Removed exports from `src/lib/audit/types.ts`:
- `isWikilink`
- `isMarkdownLink`
- `extractWikilinkTarget`
- `toWikilink`
- `toMarkdownLink`

### Reason
Direct removal prevents silent breakage and ensures all current consumers of the API are explicitly migrated to the correct import path (`src/lib/links.js`), establishing a clear transition policy.
