# Hypha RPC (WIP)

Hypha RPC is a complete rewrite of imjoy-rpc, it provides improved life time managements and make the rpc works in peer-to-peer manner.

## Usage

## Data type representation

ImJoy RPC is built on top of two-way transport layer. Currently, we support 4 types of transport layer: [Jupyter comm messages](https://jupyter-notebook.readthedocs.io/en/stable/comms.html), [Pyodide](https://github.com/iodide-project/pyodide), Google Colab, and SocketIO. Data with different types are encoded into a unified representation and sent over the transport layer. It will then be decoded into the same or corresponding data type on the other side.

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
 For the data or object types that are not in the table above, for example, a custom class, you can support them by register your own `codec`(i.e. encoder and decoder) with `api.registerCodec()`.

 You need to provide a `name`, a `type`, `encoder` and `decoder` function. For example: in javascript, you can call `api.registerCodec({"name": "my_custom_codec", "type": MyClass, "encoder": (obj)=>{ ... return encoded;}, "decoder": (obj)=>{... return decoded;})`, or in Python you can do `api.registerCodec(name="my_custom_codec", type=MyClass, encoder=my_encoder_func, decoder=my_decoder_func)`.
 

 The basic idea of using a custom codec is to use the `encoder` to represent your custom data type into array/dictionary of primitive types (string, number etc.) such that they can be send via the transport layer of imjoy-rpc. Then use the `decoder` to reconstruct the object remotely based on the representation.

For the `name`, it will be assigned as `_rtype` for the data representation, therefore please be aware that you should not use a name that already used internally (see the table above), unless you want to overried the default encoding. Also note that you cannot overried the encoding of primitive types and functions.

The `encoder` function take an object as input and you need to return the represented object/dictionary. You can only use primitive types plus array/list and object/dict in the represented object. By default, if your returned object does not contain a key `_rtype`, the codec `name` will be used as `_rtype`. You can also assign a different `_rtype` name, that allows the conversion between different types.

The `decoder` function converts the encoded object into the actual object. It will only be called when the `_rtype` of an object matches the `name` of the codec.
