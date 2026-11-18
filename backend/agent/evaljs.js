import vm from 'node:vm'

// evaluate javascript safely in an isolated sandbox --------------------
  export async function evaluatejavascript(code, timeoutms = 2000) {
    const trimmed = String(code || '').trim()
    if (!trimmed) {
      return { error: 'code is required' }
    }

    const logs = []
    const pushlog = (level, args) => {
      const rendered = args
        .map(arg => {
          if (arg === null) return 'null'
          if (arg === undefined) return 'undefined'
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg, null, 2)
            } catch {
              return String(arg)
            }
          }
          return String(arg)
        })
        .join(' ')
      logs.push(level ? `[${level}] ${rendered}` : rendered)
    }

    const sandbox = {
      console: {
        log: (...args) => pushlog('', args),
        info: (...args) => pushlog('info', args),
        warn: (...args) => pushlog('warn', args),
        error: (...args) => pushlog('error', args),
      },
      Math,
      Date,
      JSON,
      Number,
      String,
      Array,
      Boolean,
      RegExp,
      Object,
      Map,
      Set,
      Promise,
      setTimeout,
      clearTimeout,
      BigInt,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURI,
      decodeURI,
      encodeURIComponent,
      decodeURIComponent,
      Intl,
    }

    const context = vm.createContext(sandbox)
    const timeout = Math.max(100, Math.min(timeoutms, 5000))

    const stringifyresult = (val) => {
      if (val === undefined) return undefined
      if (typeof val === 'object' && val !== null) {
        try {
          return JSON.stringify(val, null, 2)
        } catch {
          return String(val)
        }
      }
      return String(val)
    }

    // strategy 1: run as expression directly --------------------
    try {
      const script = new vm.Script(trimmed, { filename: 'eval_js.js' })
      let res = script.runInContext(context, { timeout })
      if (res && typeof res.then === 'function') {
        res = await Promise.race([
          res,
          new Promise((_, reject) => setTimeout(() => reject(new Error('execution timed out')), timeout))
        ])
      }
      return {
        success: true,
        result: stringifyresult(res),
        logs: logs.length ? logs.join('\n').trim() : undefined
      }
    } catch (directerr) {
      // strategy 2: if it contains return statement or await, wrap in an async IIFE --------------------
      try {
        const isasync = trimmed.includes('await') || trimmed.includes('return')
        const wrapped = isasync
          ? `(async () => {\n${trimmed}\n})()`
          : `(() => {\n${trimmed}\n})()`
        const script = new vm.Script(wrapped, { filename: 'eval_js.js' })
        let res = script.runInContext(context, { timeout })
        if (res && typeof res.then === 'function') {
          res = await Promise.race([
            res,
            new Promise((_, reject) => setTimeout(() => reject(new Error('execution timed out')), timeout))
          ])
        }
        return {
          success: true,
          result: stringifyresult(res),
          logs: logs.length ? logs.join('\n').trim() : undefined
        }
      } catch (wrappederr) {
        return {
          success: false,
          error: wrappederr.message || directerr.message,
          logs: logs.length ? logs.join('\n').trim() : undefined
        }
      }
    }
  }
