# ImJoy RPC

## Usage

Load the library to the browser
```html
<script
  type="text/javascript"
  onload="imjoyRPC.setupBaseFrame()"
  src="https://lib.imjoy.io/imjoy-rpc.js"
></script>
```

Or, you can use the npm module:
```bash
npm install imjoy-rpc
```

```js
import * as imjoyRPC from "imjoy-rpc";

imjoyRPC.setupRPC().then(api => {

})

```

### `imjoyRPC.setupBaseFrame`
To bootstrap an iframe:
```html
<script
  type="text/javascript"
  onload="imjoyRPC.setupBaseFrame()"
  src="/imjoy-rpc.js"
></script>
```

### `imjoyRPC.setupRPC`

Setup ImJoy RPC manually:
```js
imjoyRPC.setupRPC(config).then((api)=>{
    // use the api object to interact with imjoy-core
})
```

### Configuration for `setupRPC`
 * allow_execution
  Allow code execution

  Default: `false`

 * target_origin
  Set the target origin for postMessage

  Default: `*`
 * enable_service_worker
  Enable service worker for cachine requirements

  Default: `false`

 * cache_requirements
  A callback function for caching requirements in the service worker

  Default: `null`
