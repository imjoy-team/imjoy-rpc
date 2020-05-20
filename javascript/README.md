# ImJoy RPC

## Usage

Load the library to the browser
```html
<script
  type="text/javascript"
  onload="imjoyRPC.setupRPC()"
  src="https://cdn.jsdelivr.net/npm/imjoy-rpc@0.2.6/dist/imjoy-rpc.min.js"
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

### `imjoyRPC.waitForInitialization`

This function is used to setup a base frame for running plugins. 
It will send `imjoyRPCReady` signal to the imjoy-core and listen for the `initialize` signal.
Once received, it will call `setupRPC` with the `config` from the imjoy-core:
```html
<script
  type="text/javascript"
  onload="imjoyRPC.waitForInitialization()"
  src="https://cdn.jsdelivr.net/npm/imjoy-rpc@0.2.6/dist/imjoy-rpc.min.js"
></script>
```

If needed, the authentication will also be done in this step (see config below).

#### config
You can optionally pass a config object into the function `imjoyRPC.waitForInitialization(config)`

 * `config.credential_required`: `boolean`, whether your RPC app requires credentials
 * `config.credential_fields`: `array`(of `object`), what are the fields required for the credentials, the properties of the objects will be used to generate HTML `<input>` field, it should contain `label`, `id`, `value`(the default value), `type`(any type supported by `<input>`, e.g.: `text`, `number`, `password`). For example: `[{id: 'username', label: 'User Name', value: '', type: 'text'}, {id: 'password', label: 'Password', value: '', type: 'password'}]`.
 * `config.verify_credential`: `function`, a function to check if the submitted credential is valid
 * `config.target_origin`: `string`, the target origin required to connect to the RPC app, it's mandatory to set an explicit origin.

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
