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

imjoyRPC.setupRPC({name: 'My Awesome App'}).then(api => {

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
imjoyRPC.setupRPC({name: 'My Awesome App'}).then((api)=>{
    // use the api object to interact with imjoy-core
})
```

### Configuration for `setupRPC`
 * name 
  Name of your app

  **Required**

 * description
  Short description of your app

  Default: `[TODO: add description for YOUR APP]`

 * version
  Version of your app

  Default: `"0.1.0"`

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

 * forwarding_functions
  A list of function names which will be exported automatically and forwarded to the remote api.
  Default: `["close", "on", "off", "emit"]` for all plugins, window plugins will include additional ones: `["resize", "show", "hide", "refresh"]`

### Implement your own connection
