# ImJoy RPC V2

ImJoy RPC V2 is a complete rewrite of imjoy-rpc, it provides improved life time managements and make the rpc works in peer-to-peer manner.

## Usage

The imjoy-rpc v2 is wrapped under a submodule `imjoy_rpc.hypha`:

```python
from imjoy_rpc.hypha import connect_to_server
server = await connect_to_server({"server_url": server_url})
```

You can also obtain a login token from the server and use it to connect to the server:
```python
from imjoy_rpc.hypha import login, connect_to_server
token = await login({"server_url": server_url})
server = await connect_to_server({"server_url": server_url, "token": token})
```
## Data type representation

ImJoy RPC is built on top of two-way transport layer. Currently, we use `websocket` to implement the transport layer between different peers. Data with different types are encoded into a unified representation and sent over the transport layer. It will then be decoded into the same or corresponding data type on the other side.

The data representation is a JSON object (but can contain binary data, e.g. `ArrayBuffer` in JS or `bytes` in Python). The goal is to represent more complex data types with primitive types that are commonly supported by many programming language, including strings, numbers, boolean, bytes, list/array and dictionary/object.


| Javascript | Python | imjoy-rpc representation |
|------------|--------- | ---- |
| String   | str        | v |
| Number   | int/float | v |
| Boolean  |  bool     | v |
| null/undefined  | None    | v |
| Uint8Array | bytes  | v |
| ArrayBuffer | memoryview  | {_rtype: "memoryview", _rvalue: v} |
| Array([])   | list/tuple |[_encode(v)] |
| Object({})  | dict  | {_encode(v)} |
| Set | Set | {_rtype: "set", _rvalue: _encode(Array.from(v))} |
| Map | OrderedDict  |{_rtype: "orderedmap", _rvalue: _encode(Array.from(v))} |
| Error | Exception | { _rtype: "error", _rvalue: v.toString() } |
| Blob/File | BytesIO/StringIO etc.  | { _rtype: "iostream", name: v, type: v.type, read: v.read, seek: v.seek, ...} |
| DataView | memoryview  |  { _rtype: "memoryview", _rvalue: v.buffer }|
| TypedArray | 1-D numpy array*  |{_rtype: "typedarray", _rvalue: v.buffer, _rdtype: dtype} |
| tf.Tensor/nj.array | numpy array  |{_rtype: "ndarray", _rvalue: v.buffer, _rshape: shape, _rdtype: _dtype} |
| Function* | function/callable* | {_rtype: "method", _rtarget: _rid, _rmethod: name, _rpromise: true } |
| Class | class/dotdict()* | {...} |
| custom | custom | encoder(v) (default `_rtype` = encoder name) |

Notes:
 - `_encode(...)` in the imjoy-rpc representation means the type will be recursively encoded (decoded).
 - For n-D numpy array, there is no established n-D array library in javascript, the current behavior is, if there is `tf`(Tensorflow.js) detected, then it will be decoded into `tf.Tensor`. If `nj`(numjs) is detected, then it will be decoded into `nj.array`.
 - Typed array will be represented as numpy array if available, otherwise it will be converted to raw bytes.    
    Type Conversion
    | Javascript | Numpy  | _rdtype |
    | -- | -- | -- |
    | Int8Array | int8 | int8 |
    | Int16Array| int16 |int16 |
    |  Int32Array| int32 | int32 |
    |  Uint8Array| uint8 | uint8 |
    |  Uint16Array| uint16 | uint16 |
    |  Uint32Array| uint32 | uint32 |
    |  Float32Array| float32 | float32 |
    |  Float64Array| float64 | float64 |
    |  Array| array | array |
    |note: 64-bit integers (signed or unsigned) are not supported|

 - `dotdict` in Python is a simple wrapper over `dict` that support using the dot notation to get item, similar to what you can do with Javascript object.
 - In Python, file instances (inherit from `io.IOBase`) will be automatically encoded.

## Encoding and decoding custom objects
 For the data or object types that are not in the table above, for example, a custom class, you can support them by register your own `codec`(i.e. encoder and decoder) with `api.register_codec()`.

 You need to provide a `name`, a `type`, `encoder` and `decoder` function. For example: in javascript, you can call `api.register_codec({"name": "my_custom_codec", "type": MyClass, "encoder": (obj)=>{ ... return encoded;}, "decoder": (obj)=>{... return decoded;})`, or in Python you can do `api.register_codec(name="my_custom_codec", type=MyClass, encoder=my_encoder_func, decoder=my_decoder_func)`.
 

 The basic idea of using a custom codec is to use the `encoder` to represent your custom data type into array/dictionary of primitive types (string, number etc.) such that they can be send via the transport layer of imjoy-rpc. Then use the `decoder` to reconstruct the object remotely based on the representation.

For the `name`, it will be assigned as `_rtype` for the data representation, therefore please be aware that you should not use a name that already used internally (see the table above), unless you want to overried the default encoding. Also note that you cannot overried the encoding of primitive types and functions.

The `encoder` function take an object as input and you need to return the represented object/dictionary. You can only use primitive types plus array/list and object/dict in the represented object. By default, if your returned object does not contain a key `_rtype`, the codec `name` will be used as `_rtype`. You can also assign a different `_rtype` name, that allows the conversion between different types.

The `decoder` function converts the encoded object into the actual object. It will only be called when the `_rtype` of an object matches the `name` of the codec.
### Example 1: Encode and Decode xarray

Here you can find an example for encoding and decoding [xarray](https://xarray.dev/):
```python
import asyncio
from imjoy_rpc.hypha import connect_to_server
import xarray as xr
import numpy as np

def encode_xarray(obj):
    """Encode the zarr store."""
    assert isinstance(obj, xr.DataArray)
    return {
        "_rintf": True,
        "_rtype": "xarray",
        "data": obj.data,
        "dims": obj.dims,
        "attrs": obj.attrs,
        "name": obj.name,
    }

def decode_xarray(obj):
    assert obj["_rtype"] == "xarray"
    return xr.DataArray(
                data=obj["data"],
                dims=obj["dims"],
                attrs=obj.get("attrs", {}),
                name=obj.get("name", None),
        )


async def start_server(server_url):
    server = await connect_to_server({"server_url": server_url})

    # Register the codecs
    server.register_codec(
        {"name": "xarray", "type": xr.DataArray, "encoder": encode_xarray, "decoder": decode_xarray}
    )
    
    z = xr.DataArray(data=np.arange(100), dims=["x"], attrs={"test": "test"}, name="mydata")

    # Use the echo function to do a round-trip with the xarray object
    # It will first encode z and send it to the server, then the server return the encoded object and decoded it back to a xarray
    z2 = await server.echo(z)

    assert isinstance(z2, xr.DataArray)
    assert z2.attrs["test"] == "test"
    assert z2.dims == ("x",)
    assert z2.data[0] == 0
    assert z2.data[99] == 99
    assert z2.name == "mydata"
    print("Success!")

if __name__ == "__main__":
    server_url = "https://ai.imjoy.io"
    loop = asyncio.get_event_loop()
    loop.create_task(start_server(server_url))
    loop.run_forever()

```


### Example 2: Encode zarr store

Since we can include functions in the encoded object, this allows us sending an interface to the remote location and use it as a lazy object.

```python
import asyncio
from imjoy_rpc.hypha import connect_to_server

import zarr
import numpy as np

def encode_zarr_store(zobj):
    """Encode the zarr store."""
    import zarr

    path_prefix = f"{zobj.path}/" if zobj.path else ""

    def getItem(key, options=None):
        return zobj.store[path_prefix + key]

    def setItem(key, value):
        zobj.store[path_prefix + key] = value

    def containsItem(key, options=None):
        if path_prefix + key in zobj.store:
            return True

    return {
        "_rintf": True,
        "_rtype": "zarr-array" if isinstance(zobj, zarr.Array) else "zarr-group",
        "getItem": getItem,
        "setItem": setItem,
        "containsItem": containsItem,
    }


async def start_server(server_url):
    server = await connect_to_server({"server_url": server_url})

    # Register the codecs
    server.register_codec(
        {"name": "zarr-group", "type": zarr.Group, "encoder": encode_zarr_store}
    )

    z = zarr.array(np.arange(100))
  
    # Use the echo function to do a round-trip with the zarr object
    # Note: Since we didn't create a decoder, so we won't get the zarr object, but a zarr store interface
    z2 = await server.echo(z)
    print(z2)

if __name__ == "__main__":
    server_url = "https://ai.imjoy.io"
    loop = asyncio.get_event_loop()
    loop.create_task(start_server(server_url))
    loop.run_forever()
```


### Remote function calls and arguments
Remote function call is almost the same as calling a local function. The arguments are mapped directly, for example, you can call a Python function `foo(a, b, c)` from javascript or vise versa. However, since Javascript does not support named arguments as Python does, ImJoy does the following conversion:
 * For functions defined in Javascript, there is no difference when calling from Python
 * For functions defined in Python, when calling from Javascript, if the last argument is an object and its `_rkwargs` is set to true, then it will be converted into keyword arguments when calling the Python function. For example, if you have a Python function defined as `def foo(a, b, c=None):`, in Javascript, you should call it as `foo(9, 10, {c: 33, _rkwargs: true})`.


## Synchronous Wrapper

To make it easier to work with synchronous python code, we provide a synchronous wrapper, which allows for synchronous usage of the asynchronous `imjoy_rpc.hypha` API.

To use the synchronous wrapper, you can import the following functions from the `imjoy_rpc.hypha.sync` module:

```python
from imjoy_rpc.hypha.sync import login, connect_to_server, get_rtc_service, register_rtc_service
```
**connect_to_server**

The `connect_to_server` function creates a synchronous Hypha server instance and establishes a connection to the server. It takes a configuration object as an argument and returns the server instance.

```python
server = connect_to_server(config)
```

**Example:**

```python
server_url = "https://ai.imjoy.io"
server = connect_to_server({"server_url": server_url})
```


**login**

The `login` function is used to log in to a Hypha server. It takes a configuration object as an argument and returns the token for connecting to the server.

```python
token = login(config)
```

**Example:**

```python
server_url = "https://ai.imjoy.io"

def login_callback(context):
    print("Please open the following URL in your browser to log in:")
    print(context["login_url"])

config = {
    "server_url": server_url,
    "login_callback": login_callback,
}

token = login(config)
server = connect_to_server({"server_url": server_url, "token": token})
```

The `config` object should contain the following properties:

- `server_url`: The URL of the Hypha server.
- `login_service_id`: The service ID for the login service (default: "public/*:hypha-login").
- `login_timeout`: The timeout duration for the login process (default: 60 seconds).
- `login_callback`: An optional callback function to handle the login process.

The `login` function connects to the Hypha server, starts the login service, and initiates the login process. If a `login_callback` function is provided, it will be called with the login context. Otherwise, the login URL will be printed to the console, and the user needs to open their browser and complete the login process.

The function returns the result of the login process, which is obtained by checking the login key within the specified timeout duration.


**get_rtc_service**

The `get_rtc_service` function retrieves a synchronous Real-Time Communication (RTC) service from the Hypha server. It takes the server instance and a service ID as arguments and returns the synchronous RTC service.

```python
rtc_service = get_rtc_service(server, service_id, config=None)
```

**Example:**

```python
rtc_service = get_rtc_service(server, "webrtc-service")
```

**register_rtc_service**

The `register_rtc_service` function registers a synchronous RTC service with the Hypha server. It takes the server instance, service ID, and an optional configuration object as arguments.

```python
register_rtc_service(server, service_id, config=None)
```

**Example:**

```python
register_rtc_service(
    server,
    service_id="webrtc-service",
    config={
        "visibility": "public",
        # "ice_servers": ice_servers,
    },
)
```

Please note that the synchronous wrapper is designed to provide a convenient synchronous interface for the asynchronous `imjoy-rpc` API. It utilizes asyncio and threading under the hood to achieve synchronous behavior.
