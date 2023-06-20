// Smoldot
// Copyright (C) 2019-2022  Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later WITH Classpath-exception-2.0

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import * as buffer from './buffer.js';

/**
 * Configuration for {@link startLocalInstance}.
 */
export interface Config {
    forbidTcp: boolean,
    forbidWs: boolean,
    forbidNonLocalWs: boolean,
    forbidWss: boolean,
    forbidWebRtc: boolean,

    /**
     * Maximum level of the logs that are generated.
     */
    maxLogLevel: number,

    /**
     * Number between 0.0 and 1.0 indicating how much of the CPU time the instance is allowed to
     * consume.
     */
    cpuRateLimit: number,

    /**
     * Environment variables that the instance can pull.
     */
    envVars: string[],

    /**
     * Returns the number of milliseconds since an arbitrary epoch.
     */
    performanceNow: () => number,

    /**
     * Fills the given buffer with randomly-generated bytes.
     */
    getRandomValues: (buffer: Uint8Array) => void,
}

export type Event =
    { ty: "add-chain-result", success: true, chainId: number } |
    { ty: "add-chain-result", success: false, error: string } |
    { ty: "log", level: number, target: string, message: string } |
    { ty: "json-rpc-responses-non-empty", chainId: number } |
    // Smoldot has crashed. Note that the public API of the instance can technically still be
    // used, as all functions will start running fallback code. Existing connections are *not*
    // closed. It is the responsibility of the API user to close all connections if they stop
    // using the instance.
    { ty: "wasm-panic", message: string, currentTask: string | null } |
    { ty: "executor-shutdown" } |
    { ty: "new-connection", connectionId: number, address: ParsedMultiaddr } |
    { ty: "connection-reset", connectionId: number } |
    { ty: "connection-stream-open", connectionId: number } |
    { ty: "connection-stream-reset", connectionId: number, streamId: number } |
    { ty: "stream-send", connectionId: number, streamId?: number, data: Uint8Array } |
    { ty: "stream-send-close", connectionId: number, streamId?: number };

export type ParsedMultiaddr =
    { ty: "tcp", hostname: string, port: number } |
    { ty: "websocket", url: string } |
    { ty: "webrtc", targetPort: string, ipVersion: string, targetIp: string, remoteCertMultibase: string };

export interface Instance {
    request: (request: string, chainId: number) => number,
    peekJsonRpcResponse: (chainId: number) => string | null,
    addChain: (chainSpec: string, databaseContent: string, potentialRelayChains: number[], disableJsonRpc: boolean, jsonRpcMaxPendingRequests: number, jsonRpcMaxSubscriptions: number) => void,
    removeChain: (chainId: number) => void,
    /**
     * Notifies the background executor that it should stop. Once it has effectively stopped,
     * a `executor-shutdown` event will be generated.
     * Note that the instance can technically still be used, and all the functions still work, but
     * in practice nothing is being run in the background and as such it won't do much.
     * Existing connections are *not* closed. It is the responsibility of the API user to close
     * all connections.
     */
    shutdownExecutor: () => void,
    connectionOpened: (connectionId: number, info: { type: 'single-stream', handshake: 'multistream-select-noise-yamux', initialWritableBytes: number, writeClosable: boolean } | { type: 'multi-stream', handshake: 'webrtc', localTlsCertificateMultihash: Uint8Array, remoteTlsCertificateMultihash: Uint8Array }) => void,
    connectionReset: (connectionId: number, message: string) => void,
    streamWritableBytes: (connectionId: number, numExtra: number, streamId?: number) => void,
    streamMessage: (connectionId: number, message: Uint8Array, streamId?: number) => void,
    streamOpened: (connectionId: number, streamId: number, direction: 'inbound' | 'outbound', initialWritableBytes: number) => void,
    streamReset: (connectionId: number, streamId: number) => void,
}

/**
 * Starts a new instance using the given configuration.
 *
 * Even though this function doesn't do anything asynchronous, it needs to be asynchronous due to
 * the fact that `WebAssembly.instantiate` is for some reason asynchronous.
 *
 * After this function returns, the execution of CPU-heavy tasks of smoldot will happen
 * asynchronously in the background.
 *
 * This instance is low-level in the sense that invalid input can lead to crashes and that input
 * isn't sanitized. In other words, you know what you're doing.
 */
export async function startLocalInstance(config: Config, wasmModule: WebAssembly.Module, eventCallback: (event: Event) => void): Promise<Instance> {
    const state: {
        // Null before initialization and after a panic.
        instance: SmoldotWasmInstance | null,
        // Name of the task currently being executed by smoldot. Used for diagnostics in case of
        // a panic. `null` if not in a task.
        currentTask: string | null,
        bufferIndices: Uint8Array[],
        advanceExecutionPromise: null | (() => void),
        stdoutBuffer: string,
        stderrBuffer: string,
        onShutdownExecutorOrWasmPanic: () => void,
    } = {
        instance: null,
        currentTask: null,
        bufferIndices: new Array(),
        advanceExecutionPromise: null,
        stdoutBuffer: "",
        stderrBuffer: "",
        onShutdownExecutorOrWasmPanic: () => { }
    };

    const smoldotJsBindings = {
        // Must exit with an error. A human-readable message can be found in the WebAssembly
        // memory in the given buffer.
        panic: (ptr: number, len: number) => {
            const instance = state.instance!;
            state.instance = null;

            ptr >>>= 0;
            len >>>= 0;

            const message = buffer.utf8BytesToString(new Uint8Array(instance.exports.memory.buffer), ptr, len);
            eventCallback({ ty: "wasm-panic", message, currentTask: state.currentTask });
            state.onShutdownExecutorOrWasmPanic();
            state.onShutdownExecutorOrWasmPanic = () => { };
            throw new Error();
        },

        buffer_size: (bufferIndex: number) => {
            const buf = state.bufferIndices[bufferIndex]!;
            return buf.byteLength;
        },

        buffer_copy: (bufferIndex: number, targetPtr: number) => {
            const instance = state.instance!;
            targetPtr = targetPtr >>> 0;

            const buf = state.bufferIndices[bufferIndex]!;
            new Uint8Array(instance.exports.memory.buffer).set(buf, targetPtr);
        },

        advance_execution_ready: () => {
            if (state.advanceExecutionPromise)
                state.advanceExecutionPromise();
            state.advanceExecutionPromise = null;
        },

        // Used by the Rust side to notify that a JSON-RPC response or subscription notification
        // is available in the queue of JSON-RPC responses.
        json_rpc_responses_non_empty: (chainId: number) => {
            eventCallback({ ty: "json-rpc-responses-non-empty", chainId });
        },

        // Used by the Rust side to emit a log entry.
        // See also the `max_log_level` parameter in the configuration.
        log: (level: number, targetPtr: number, targetLen: number, messagePtr: number, messageLen: number) => {
            const instance = state.instance!;

            targetPtr >>>= 0;
            targetLen >>>= 0;
            messagePtr >>>= 0;
            messageLen >>>= 0;

            const mem = new Uint8Array(instance.exports.memory.buffer);
            let target = buffer.utf8BytesToString(mem, targetPtr, targetLen);
            let message = buffer.utf8BytesToString(mem, messagePtr, messageLen);
            eventCallback({ ty: "log", level, message, target });
        },

        // Must call `timer_finished` after the given number of milliseconds has elapsed.
        start_timer: (ms: number) => {
            const instance = state.instance!;

            // In both NodeJS and browsers, if `setTimeout` is called with a value larger than
            // 2147483647, the delay is for some reason instead set to 1.
            // As mentioned in the documentation of `start_timer`, it is acceptable to end the
            // timer before the given number of milliseconds has passed.
            if (ms > 2147483647)
                ms = 2147483647;

            // In browsers, `setTimeout` works as expected when `ms` equals 0. However, NodeJS
            // requires a minimum of 1 millisecond (if `0` is passed, it is automatically replaced
            // with `1`) and wants you to use `setImmediate` instead.
            if (ms < 1 && typeof setImmediate === "function") {
                setImmediate(() => {
                    if (!state.instance) return;
                    try {
                        instance.exports.timer_finished();
                    } catch (_error) { }
                })
            } else {
                setTimeout(() => {
                    if (!state.instance) return;
                    try {
                        instance.exports.timer_finished();
                    } catch (_error) { }
                }, ms)
            }
        },

        // Must create a new connection object. This implementation stores the created object in
        // `connections`.
        connection_new: (connectionId: number, addrPtr: number, addrLen: number, errorBufferIndexPtr: number) => {
            const instance = state.instance!;

            addrPtr >>>= 0;
            addrLen >>>= 0;
            errorBufferIndexPtr >>>= 0;

            const address = buffer.utf8BytesToString(new Uint8Array(instance.exports.memory.buffer), addrPtr, addrLen);
            // TODO: consider extracting config options so user can't change the fields dynamically
            const result = parseMultiaddr(address, config.forbidTcp, config.forbidWs, config.forbidNonLocalWs, config.forbidWss, config.forbidWebRtc);
            if (result.success) {
                eventCallback({ ty: "new-connection", connectionId, address: result.address });
                return 0
            } else {
                const mem = new Uint8Array(instance.exports.memory.buffer);
                state.bufferIndices[0] = new TextEncoder().encode(result.error)
                buffer.writeUInt32LE(mem, errorBufferIndexPtr, 0);
                buffer.writeUInt8(mem, errorBufferIndexPtr + 4, 1);  // TODO: remove isBadAddress param since it's always true
                return 1;
            }
        },

        // Must close and destroy the connection object.
        reset_connection: (connectionId: number) => {
            eventCallback({ ty: "connection-reset", connectionId });
        },

        // Opens a new substream on a multi-stream connection.
        connection_stream_open: (connectionId: number) => {
            eventCallback({ ty: "connection-stream-open", connectionId });
        },

        // Closes a substream on a multi-stream connection.
        connection_stream_reset: (connectionId: number, streamId: number) => {
            eventCallback({ ty: "connection-stream-reset", connectionId, streamId });
        },

        // Must queue the data found in the WebAssembly memory at the given pointer. It is assumed
        // that this function is called only when the connection is in an open state.
        stream_send: (connectionId: number, streamId: number, ptr: number, len: number) => {
            const instance = state.instance!;

            ptr >>>= 0;
            len >>>= 0;

            const data = new Uint8Array(instance.exports.memory.buffer).slice(ptr, ptr + len);
            // TODO: docs says the streamId is provided only for multi-stream connections, but here it's always provided
            eventCallback({ ty: "stream-send", connectionId, streamId, data });
        },

        stream_send_close: (connectionId: number, streamId: number) => {
            // TODO: docs says the streamId is provided only for multi-stream connections, but here it's always provided
            eventCallback({ ty: "stream-send-close", connectionId, streamId });
        },

        current_task_entered: (ptr: number, len: number) => {
            ptr >>>= 0;
            len >>>= 0;

            const taskName = buffer.utf8BytesToString(new Uint8Array(state.instance!.exports.memory.buffer), ptr, len);
            state.currentTask = taskName;
        },

        current_task_exit: () => {
            state.currentTask = null;
        }
    };

    const wasiBindings = {
        // Need to fill the buffer described by `ptr` and `len` with random data.
        // This data will be used in order to generate secrets. Do not use a dummy implementation!
        random_get: (ptr: number, len: number) => {
            const instance = state.instance!;

            ptr >>>= 0;
            len >>>= 0;

            const baseBuffer = new Uint8Array(instance.exports.memory.buffer)
                .subarray(ptr, ptr + len);
            for (let iter = 0; iter < len; iter += 65536) {
                // `baseBuffer.subarray` automatically saturates at the end of the buffer
                config.getRandomValues(baseBuffer.subarray(iter, iter + 65536))
            }

            return 0;
        },

        clock_time_get: (clockId: number, _precision: bigint, outPtr: number): number => {
            // See <https://github.com/rust-lang/rust/blob/master/library/std/src/sys/wasi/time.rs>
            // and <docs.rs/wasi/> for help.

            const instance = state.instance!;
            const mem = new Uint8Array(instance.exports.memory.buffer);
            outPtr >>>= 0;

            // We ignore the precision, as it can't be implemented anyway.

            switch (clockId) {
                case 0: {
                    // Realtime clock.
                    const now = BigInt(Math.floor(Date.now())) * BigInt(1_000_000);
                    buffer.writeUInt64LE(mem, outPtr, now)

                    // Success.
                    return 0;
                }
                case 1: {
                    // Monotonic clock.
                    const nowMs = config.performanceNow();
                    const nowMsInt = Math.floor(nowMs);
                    const now = BigInt(nowMsInt) * BigInt(1_000_000) +
                        BigInt(Math.floor(((nowMs - nowMsInt) * 1_000_000)));
                    buffer.writeUInt64LE(mem, outPtr, now)

                    // Success.
                    return 0;
                }
                default:
                    // Return an `EINVAL` error.
                    return 28
            }
        },

        // Writing to a file descriptor is used in order to write to stdout/stderr.
        fd_write: (fd: number, addr: number, num: number, outPtr: number) => {
            const instance = state.instance!;

            outPtr >>>= 0;

            // Only stdout and stderr are open for writing.
            if (fd != 1 && fd != 2) {
                return 8;
            }

            const mem = new Uint8Array(instance.exports.memory.buffer);

            // `fd_write` passes a buffer containing itself a list of pointers and lengths to the
            // actual buffers. See writev(2).
            let toWrite = "";
            let totalLength = 0;
            for (let i = 0; i < num; i++) {
                const buf = buffer.readUInt32LE(mem, addr + 4 * i * 2);
                const bufLen = buffer.readUInt32LE(mem, addr + 4 * (i * 2 + 1));
                toWrite += buffer.utf8BytesToString(mem, buf, bufLen);
                totalLength += bufLen;
            }

            const flushBuffer = (string: string) => {
                // As documented in the documentation of `println!`, lines are always split by a
                // single `\n` in Rust.
                while (true) {
                    const index = string.indexOf('\n');
                    if (index != -1) {
                        // Note that it is questionnable to use `console.log` from within a
                        // library. However this simply reflects the usage of `println!` in the
                        // Rust code. In other words, it is `println!` that shouldn't be used in
                        // the first place. The harm of not showing text printed with `println!`
                        // at all is greater than the harm possibly caused by accidentally leaving
                        // a `println!` in the code.
                        console.log(string.substring(0, index));
                        string = string.substring(index + 1);
                    } else {
                        return string;
                    }
                }
            };

            // Append the newly-written data to either `stdout_buffer` or `stderr_buffer`, and
            // print their content if necessary.
            if (fd == 1) {
                state.stdoutBuffer += toWrite;
                state.stdoutBuffer = flushBuffer(state.stdoutBuffer);
            } else if (fd == 2) {
                state.stderrBuffer += toWrite;
                state.stderrBuffer = flushBuffer(state.stderrBuffer);
            }

            // Need to write in `out_ptr` how much data was "written".
            buffer.writeUInt32LE(mem, outPtr, totalLength);
            return 0;
        },

        // It's unclear how to properly implement yielding, but a no-op works fine as well.
        sched_yield: () => {
            return 0;
        },

        // Used by Rust in catastrophic situations, such as a double panic.
        proc_exit: (retCode: number) => {
            state.instance = null;
            eventCallback({
                ty: "wasm-panic",
                message: `proc_exit called: ${retCode}`,
                currentTask: state.currentTask
            });
            state.onShutdownExecutorOrWasmPanic();
            state.onShutdownExecutorOrWasmPanic = () => { };
            throw new Error();
        },

        // Return the number of environment variables and the total size of all environment
        // variables. This is called in order to initialize buffers before `environ_get`.
        environ_sizes_get: (argcOut: number, argvBufSizeOut: number) => {
            const instance = state.instance!;

            argcOut >>>= 0;
            argvBufSizeOut >>>= 0;

            let totalLen = 0;
            config.envVars.forEach(e => totalLen += new TextEncoder().encode(e).length + 1); // +1 for trailing \0

            const mem = new Uint8Array(instance.exports.memory.buffer);
            buffer.writeUInt32LE(mem, argcOut, config.envVars.length);
            buffer.writeUInt32LE(mem, argvBufSizeOut, totalLen);
            return 0;
        },

        // Write the environment variables to the given pointers.
        // `argv` is a pointer to a buffer that must be overwritten with a list of pointers to
        // environment variables, and `argvBuf` is a pointer to a buffer where to actually store
        // the environment variables.
        // The sizes of the buffers were determined by calling `environ_sizes_get`.
        environ_get: (argv: number, argvBuf: number) => {
            const instance = state.instance!;

            argv >>>= 0;
            argvBuf >>>= 0;

            const mem = new Uint8Array(instance.exports.memory.buffer);

            let argvPos = 0;
            let argvBufPos = 0;

            config.envVars.forEach(envVar => {
                const encoded = new TextEncoder().encode(envVar);

                buffer.writeUInt32LE(mem, argv + argvPos, argvBuf + argvBufPos);
                argvPos += 4;

                mem.set(encoded, argvBuf + argvBufPos);
                argvBufPos += encoded.length;
                buffer.writeUInt8(mem, argvBuf + argvBufPos, 0);
                argvBufPos += 1;
            });

            return 0;
        },
    };

    // Start the Wasm virtual machine.
    // The Rust code defines a list of imports that must be fulfilled by the environment. The second
    // parameter provides their implementations.
    const result = await WebAssembly.instantiate(wasmModule, {
        // The functions with the "smoldot" prefix are specific to smoldot.
        "smoldot": smoldotJsBindings,
        // As the Rust code is compiled for wasi, some more wasi-specific imports exist.
        "wasi_snapshot_preview1": wasiBindings,
    });

    state.instance = result as SmoldotWasmInstance;

    // Smoldot requires an initial call to the `init` function in order to do its internal
    // configuration.
    state.instance.exports.init(config.maxLogLevel);

    // Promise that is notified when the `shutdownExecutor` function is called or when a Wasm
    // panic happens.
    const shutdownExecutorOrWasmPanicPromise = new Promise<"stop">((resolve) => state.onShutdownExecutorOrWasmPanic = () => resolve("stop"));

    (async () => {
        const cpuRateLimit = config.cpuRateLimit;

        // In order to avoid calling `setTimeout` too often, we accumulate sleep up until
        // a certain threshold.
        let missingSleep = 0;

        let now = config.performanceNow();

        while (true) {
            const whenReadyAgain = new Promise<"ready">((resolve) => state.advanceExecutionPromise = () => resolve("ready"));

            if (!state.instance)
                break;
            state.instance.exports.advance_execution();

            const afterExec = config.performanceNow();
            const elapsed = afterExec - now;
            now = afterExec;

            // In order to enforce the rate limiting, we stop executing for a certain
            // amount of time.
            // The base equation here is: `(sleep + elapsed) * rateLimit == elapsed`,
            // from which the calculation below is derived.
            const sleep = elapsed * (1.0 / cpuRateLimit - 1.0);
            missingSleep += sleep;

            if (missingSleep > 5) {
                // `setTimeout` has a maximum value, after which it will overflow. 🤦
                // See <https://developer.mozilla.org/en-US/docs/Web/API/setTimeout#maximum_delay_value>
                // While adding a cap technically skews the CPU rate limiting algorithm, we don't
                // really care for such extreme values.
                if (missingSleep > 2147483646)  // Doc says `> 2147483647`, but I don't really trust their pedanticism so let's be safe
                    missingSleep = 2147483646;

                const sleepFinished = new Promise<"timeout" | "stop">((resolve) => setTimeout(() => resolve("timeout"), missingSleep));
                if (await Promise.race([sleepFinished, shutdownExecutorOrWasmPanicPromise]) === "stop")
                    break;
            }

            if (await Promise.race([whenReadyAgain, shutdownExecutorOrWasmPanicPromise]) === "stop")
                break;

            const afterWait = config.performanceNow();

            // `afterWait - now` is equal to how long we've waited for the `setTimeout` callback to
            // trigger. While in principle `afterWait - now` should be roughly equal to
            // `missingSleep`, in reality `setTimeout` can take much longer than the parameter
            // provided. See <https://developer.mozilla.org/en-US/docs/Web/API/setTimeout#timeouts_in_inactive_tabs>.
            // For this reason, `missingSleep` can become negative here. This is intended.
            // However, we don't want to accumulate too much sleep. There should be a maximum
            // amount of time during which the CPU executes without yielding. For this reason, we
            // add a minimum bound for `missingSleep`.
            missingSleep -= (afterWait - now);
            if (missingSleep < -10000)
                missingSleep = -10000;

            now = afterWait;
        }

        if (!state.instance)
            return;
        eventCallback({ ty: "executor-shutdown" })
    })();

    return {
        request: (request: string, chainId: number) => {
            if (!state.instance)
                return 2;  // TODO: return a different error code? should be documented
            state.bufferIndices[0] = new TextEncoder().encode(request);
            return state.instance.exports.json_rpc_send(0, chainId) >>> 0;
        },

        peekJsonRpcResponse: (chainId: number): string | null => {
            if (!state.instance)
                return null;

            const mem = new Uint8Array(state.instance.exports.memory.buffer);
            const responseInfo = state.instance.exports.json_rpc_responses_peek(chainId) >>> 0;
            const ptr = buffer.readUInt32LE(mem, responseInfo) >>> 0;
            const len = buffer.readUInt32LE(mem, responseInfo + 4) >>> 0;

            // `len === 0` means "queue is empty" according to the API.
            // In that situation, queue the resolve/reject.
            if (len !== 0) {
                const message = buffer.utf8BytesToString(mem, ptr, len);
                state.instance.exports.json_rpc_responses_pop(chainId);
                return message;
            } else {
                return null
            }
        },

        addChain: (chainSpec: string, databaseContent: string, potentialRelayChains: number[], disableJsonRpc: boolean, jsonRpcMaxPendingRequests: number, jsonRpcMaxSubscriptions: number) => {
            if (!state.instance) {
                eventCallback({ ty: "add-chain-result", success: false, error: "Smoldot has crashed" });
                return;
            }

            // The caller is supposed to avoid this situation.
            console.assert(
                disableJsonRpc || jsonRpcMaxPendingRequests != 0,
                "invalid jsonRpcMaxPendingRequests value passed to local-instance::addChain"
            );

            // `add_chain` unconditionally allocates a chain id. If an error occurs, however, this chain
            // id will refer to an *erroneous* chain. `chain_is_ok` is used below to determine whether it
            // has succeeeded or not.
            state.bufferIndices[0] = new TextEncoder().encode(chainSpec)
            state.bufferIndices[1] = new TextEncoder().encode(databaseContent)
            const potentialRelayChainsEncoded = new Uint8Array(potentialRelayChains.length * 4)
            for (let idx = 0; idx < potentialRelayChains.length; ++idx) {
                buffer.writeUInt32LE(potentialRelayChainsEncoded, idx * 4, potentialRelayChains[idx]!);
            }
            state.bufferIndices[2] = potentialRelayChainsEncoded
            const chainId = state.instance.exports.add_chain(0, 1, disableJsonRpc ? 0 : jsonRpcMaxPendingRequests, jsonRpcMaxSubscriptions, 2);

            delete state.bufferIndices[0]
            delete state.bufferIndices[1]
            delete state.bufferIndices[2]

            if (state.instance.exports.chain_is_ok(chainId) != 0) {
                eventCallback({ ty: "add-chain-result", success: true, chainId });
            } else {
                const errorMsgLen = state.instance.exports.chain_error_len(chainId) >>> 0;
                const errorMsgPtr = state.instance.exports.chain_error_ptr(chainId) >>> 0;
                const errorMsg = buffer.utf8BytesToString(new Uint8Array(state.instance.exports.memory.buffer), errorMsgPtr, errorMsgLen);
                state.instance.exports.remove_chain(chainId);
                eventCallback({ ty: "add-chain-result", success: false, error: errorMsg });
            }
        },

        removeChain: (chainId: number): void => {
            if (!state.instance)
                return;
            state.instance.exports.remove_chain(chainId);
        },

        shutdownExecutor: (): void => {
            if (!state.instance)
                return;
            const cb = state.onShutdownExecutorOrWasmPanic;
            state.onShutdownExecutorOrWasmPanic = () => { };
            cb();
        },

        connectionOpened: (connectionId: number, info: { type: 'single-stream', handshake: 'multistream-select-noise-yamux', initialWritableBytes: number, writeClosable: boolean } | { type: 'multi-stream', handshake: 'webrtc', localTlsCertificateMultihash: Uint8Array, remoteTlsCertificateMultihash: Uint8Array }) => {
            if (!state.instance)
                return;
            switch (info.type) {
                case 'single-stream': {
                    state.instance.exports.connection_open_single_stream(connectionId, 0, info.initialWritableBytes, info.writeClosable ? 1 : 0);
                    break
                }
                case 'multi-stream': {
                    const handshakeTy = new Uint8Array(1 + info.localTlsCertificateMultihash.length + info.remoteTlsCertificateMultihash.length);
                    buffer.writeUInt8(handshakeTy, 0, 0);
                    handshakeTy.set(info.localTlsCertificateMultihash, 1)
                    handshakeTy.set(info.remoteTlsCertificateMultihash, 1 + info.localTlsCertificateMultihash.length)
                    state.bufferIndices[0] = handshakeTy;
                    state.instance.exports.connection_open_multi_stream(connectionId, 0);
                    delete state.bufferIndices[0]
                    break
                }
            }
        },

        connectionReset: (connectionId: number, message: string) => {
            if (!state.instance)
                return;
            state.bufferIndices[0] = new TextEncoder().encode(message);
            state.instance.exports.connection_reset(connectionId, 0);
            delete state.bufferIndices[0]
        },

        streamWritableBytes: (connectionId: number, numExtra: number, streamId?: number) => {
            if (!state.instance)
                return;
            state.instance.exports.stream_writable_bytes(
                connectionId,
                streamId || 0,
                numExtra,
            );
        },

        streamMessage: (connectionId: number, message: Uint8Array, streamId?: number) => {
            if (!state.instance)
                return;
            state.bufferIndices[0] = message;
            state.instance.exports.stream_message(connectionId, streamId || 0, 0);
            delete state.bufferIndices[0]
        },

        streamOpened: (connectionId: number, streamId: number, direction: 'inbound' | 'outbound', initialWritableBytes: number) => {
            if (!state.instance)
                return;
            state.instance.exports.connection_stream_opened(
                connectionId,
                streamId,
                direction === 'outbound' ? 1 : 0,
                initialWritableBytes
            );
        },

        streamReset: (connectionId: number, streamId: number) => {
            if (!state.instance)
                return;
            state.instance.exports.stream_reset(connectionId, streamId);
        },
    };
}

/**
 * Interface that the Wasm module exports. Contains the functions that are exported by the Rust
 * code.
 *
 * Must match the bindings found in the Rust code.
 */
interface SmoldotWasmExports extends WebAssembly.Exports {
    memory: WebAssembly.Memory,
    init: (maxLogLevel: number) => void,
    advance_execution: () => void,
    add_chain: (chainSpecBufferIndex: number, databaseContentBufferIndex: number, jsonRpcMaxPendingRequests: number, jsonRpcMaxSubscriptions: number, potentialRelayChainsBufferIndex: number) => number;
    remove_chain: (chainId: number) => void,
    chain_is_ok: (chainId: number) => number,
    chain_error_len: (chainId: number) => number,
    chain_error_ptr: (chainId: number) => number,
    json_rpc_send: (textBufferIndex: number, chainId: number) => number,
    json_rpc_responses_peek: (chainId: number) => number,
    json_rpc_responses_pop: (chainId: number) => void,
    timer_finished: () => void,
    connection_open_single_stream: (connectionId: number, handshakeTy: number, initialWritableBytes: number, writeClosable: number) => void,
    connection_open_multi_stream: (connectionId: number, handshakeTyBufferIndex: number) => void,
    stream_writable_bytes: (connectionId: number, streamId: number, numBytes: number) => void,
    stream_message: (connectionId: number, streamId: number, bufferIndex: number) => void,
    connection_stream_opened: (connectionId: number, streamId: number, outbound: number, initialWritableBytes: number) => void,
    connection_reset: (connectionId: number, bufferIndex: number) => void,
    stream_reset: (connectionId: number, streamId: number) => void,
}

interface SmoldotWasmInstance extends WebAssembly.Instance {
    readonly exports: SmoldotWasmExports;
}

// TODO: consider moving this function somewhere else or something
export function parseMultiaddr(
    address: string,
    forbidTcp: boolean,
    forbidWs: boolean,
    forbidNonLocalWs: boolean,
    forbidWss: boolean,
    forbidWebRtc: boolean
): { success: true, address: ParsedMultiaddr } | { success: false, error: string } {
    const tcpParsed = address.match(/^\/(ip4|ip6|dns4|dns6|dns)\/(.*?)\/tcp\/(.*?)$/);
    // TODO: remove support for `/wss` in a long time (https://github.com/paritytech/smoldot/issues/1940)
    const wsParsed = address.match(/^\/(ip4|ip6|dns4|dns6|dns)\/(.*?)\/tcp\/(.*?)\/(ws|wss|tls\/ws)$/);
    const webRTCParsed = address.match(/^\/(ip4|ip6)\/(.*?)\/udp\/(.*?)\/webrtc-direct\/certhash\/(.*?)$/);

    if (wsParsed != null) {
        const proto = (wsParsed[4] == 'ws') ? 'ws' : 'wss';
        if (proto == 'ws' && forbidWs) {
            return { success: false, error: 'WebSocket connections not available' }
        }
        if (proto == 'wss' && forbidWss) {
            return { success: false, error: 'WebSocket secure connections not available' }
        }
        if (proto == 'ws' && wsParsed[2] != 'localhost' && wsParsed[2] != '127.0.0.1' && forbidNonLocalWs) {
            return { success: false, error: 'Non-local WebSocket connections not available' }
        }

        const url = (wsParsed[1] == 'ip6') ?
            (proto + "://[" + wsParsed[2] + "]:" + wsParsed[3]) :
            (proto + "://" + wsParsed[2] + ":" + wsParsed[3]);

        return { success: true, address: { ty: "websocket", url } }
    } else if (tcpParsed != null) {
        if (forbidTcp) {
            return { success: false, error: 'TCP connections not available' }
        }

        return { success: true, address: { ty: "tcp", hostname: tcpParsed[2]!, port: parseInt(tcpParsed[3]!) } }

    } else if (webRTCParsed != null) {
        const targetPort = webRTCParsed[3]!;
        if (forbidWebRtc) {
            return { success: false, error: 'WebRTC connections not available' }
        }
        if (targetPort === '0') {
            return { success: false, error: 'Invalid WebRTC target port' }
        }

        const ipVersion = webRTCParsed[1] == 'ip4' ? '4' : '6';
        const targetIp = webRTCParsed[2]!;
        const remoteCertMultibase = webRTCParsed[4]!;

        return { success: true, address: { ty: "webrtc", targetPort, ipVersion, targetIp, remoteCertMultibase } }

    } else {
        return { success: false, error: 'Unrecognized multiaddr format' }
    }
}
