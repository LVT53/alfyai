# Account Erasure Quiesces User Work

Account Erasure must stop or cancel user-owned running work before destructive cleanup, including live chat streams, file production, and memory maintenance that could write user data. We prefer coordinated quiescence over simple row deletion because background workers or streams could otherwise recreate messages, files, memory, or analytics after the user requested erasure.

## Update (arch-hardening C7): one owner for the quiesce sequence

The quiesce step (`quiesceUserWorkspace`: stop chat streams → cancel Atlas jobs → cancel active file production → quiesce memory maintenance) now lives in the single account-lifecycle owner (`src/lib/server/services/account-lifecycle`) alongside the destructive cleanup it must precede, rather than being split across the privacy-controls and cleanup modules. Ordering is preserved; the password-confirmed HTTP façade in `privacy-controls` simply delegates to it.
