# Changelog

## Unreleased

### Fixed

- No longer panic if passed a chain specification containing an invalid bootnode address. Because the specification of the format of a multiaddress is flexible, invalid bootnode addresses do not trigger a hard error but instead are ignored and a warning is printed. ([#2207](https://github.com/paritytech/smoldot/pull/2207))
- Fix several potential infinite loops when finality lags behind too much ([#2215](https://github.com/paritytech/smoldot/pull/2215)).

## 0.6.13 - 2022-04-05

### Fixed

- Properly fix the regression that version 0.6.12 was supposed to fix. ([#2210](https://github.com/paritytech/smoldot/pull/2210))

## 0.6.12 - 2022-04-04

### Fixed

- Fix regression introduced in version 0.6.11 causing some JSON-RPC functions to never produce a result if they were sent before the runtime of the chain has been downloaded. ([#2201](https://github.com/paritytech/smoldot/pull/2201))

## 0.6.11 - 2022-03-31

### Fixed

- Fix the `ClientOptions.cpuRateLimit` feature being misimplemented and treating any value other than 1.0 as extremely low. ([#2189](https://github.com/paritytech/smoldot/pull/2189))
- Fixed a `TimeoutOverflowWarning` caused by calling `setTimeout` with a value that is too large. ([#2188](https://github.com/paritytech/smoldot/pull/2188))

## 0.6.10 - 2022-03-29

### Fixed

- Fix parachain blocks being reported multiple times in case they have been finalized in-between ([#2182](https://github.com/paritytech/smoldot/pull/2182)).

## 0.6.9 - 2022-03-25

### Fixed

- Properly display error messages when smoldot crashes when in a browser, instead of showing `[object ErrorEvent]`. ([#2171](https://github.com/paritytech/smoldot/pull/2171))

## 0.6.8 - 2022-03-23

### Fixed

- Fix regression introduced in version 0.6.5 where we erroneously removed entries in the mapping of which peer knows which blocks, leading to failures to request data. ([#2168](https://github.com/paritytech/smoldot/pull/2168))

## 0.6.7 - 2022-03-22

### Changed

- Add more details to the debug and trace logs that happen in case of errors such as networking errors or block verification failures ([#2161](https://github.com/paritytech/smoldot/pull/2161)).

### Fixed

- Increase the threshold after which smoldot considers that a protocol name sent through multistream-select is an attempt at a DoS attack, to accomodate for the change in the GrandPa protocol name in Substrate. ([#2162](https://github.com/paritytech/smoldot/pull/2162))

## 0.6.6 - 2022-03-18

### Added

- Add `ClientOptions.cpuRateLimit`, which lets the user put an upper bound on the amount of CPU that the client uses on average ([#2151](https://github.com/paritytech/smoldot/pull/2151)).
- Add support for parsing the "fron" (Frontier) consensus log items in headers. The content of these log items is ignored by the client. ([#2150](https://github.com/paritytech/smoldot/pull/2150))

## 0.6.5 - 2022-03-17

### Changed

- Chain specifications with a `codeSubstitutes` field containing a block hash are no longer supported ([#2127](https://github.com/paritytech/smoldot/pull/2127)).
- Prune list of unverified blocks if it grows too much in order to resist spam attacks ([#2114](https://github.com/paritytech/smoldot/pull/2114)).
- Log block's parent hash in case of block announce ([#2105](https://github.com/paritytech/smoldot/pull/2105)).
- Only call `console.error` once in case of a Rust panic ([#2093](https://github.com/paritytech/smoldot/pull/2093)).

### Fixed

- Fix parachain blocks being reported multiple times in case of a relay chain fork ([#2106](https://github.com/paritytech/smoldot/pull/2106)).
- Implement the `ext_crypto_ecdsa_sign_version_1` host function ([#2120](https://github.com/paritytech/smoldot/pull/2120)).
- Implement the `ext_crypto_ecdsa_verify_version_1` host function ([#2120](https://github.com/paritytech/smoldot/pull/2120)).
- Implement the `ext_crypto_ecdsa_sign_prehashed_version_1` host function ([#2120](https://github.com/paritytech/smoldot/pull/2120)).
- Implement the `ext_crypto_ecdsa_verify_prehashed_version_1` host function ([#2120](https://github.com/paritytech/smoldot/pull/2120)).
- Properly mark all descendants as bad when a block is determined to be bad ([#2121](https://github.com/paritytech/smoldot/pull/2121)).