from types import BuiltinFunctionType
from functools import partial
from imjoy_rpc.hypha.utils import callable_sig, callable_doc, make_signature

from inspect import signature

# Import necessary modules
from inspect import signature
from typing import Union, Optional


def test_make_signature():
    """Test make_signature."""

    def func_no_arg():
        pass

    make_signature(func_no_arg, sig="func()")
    assert (
        str(signature(func_no_arg)) == "()"
    ), "Function with no argument test failed for make_signature"

    def func_pos_arg(a, b):
        pass

    make_signature(func_pos_arg, sig="func(a, b)")
    assert (
        str(signature(func_pos_arg)) == "(a, b)"
    ), "Function with positional argument test failed for make_signature"

    def func_kw_arg(a, b=2):
        pass

    make_signature(func_kw_arg, sig="func(a, b=2)")
    assert (
        str(signature(func_kw_arg)) == "(a, b=2)"
    ), "Function with keyword argument test failed for make_signature"

    def func_default_arg(a, b=None):
        pass

    make_signature(func_default_arg, sig="func(a, b=None)")
    assert (
        str(signature(func_default_arg)) == "(a, b=None)"
    ), "Function with default argument test failed for make_signature"

    def func_type_anno(a: int, b: str = "hi"):
        pass

    make_signature(func_type_anno, sig="func(a: int, b: str='hi')")
    assert (
        str(signature(func_type_anno)) == "(a: int, b: str = 'hi')"
    ), "Function with type annotation test failed for make_signature"

    def func_complex_arg(
        query: Union[dict, str, None] = None, context: Optional[dict] = None
    ):
        pass

    make_signature(
        func_complex_arg,
        sig="func_complex_arg(query: Any = None, context: Any = None) -> int",
    )
    assert (
        str(signature(func_complex_arg))
        == "(query: Any = None, context: Any = None) -> int"
    ), "Function with complex argument test failed for make_signature"

    def func_simple(workspace: str = None, context=None):
        pass

    make_signature(func_simple, sig="method(workspace: str = None, context=None)")
    assert (
        str(signature(func_simple)) == "(workspace: str = None, context=None)"
    ), "Function simple test failed for make_signature"

    # Define a function with no initial annotations
    def func_no_annotations(a, b):
        return a + b

    # Use make_signature to add annotations
    make_signature(func_no_annotations, sig="func_no_annotations(a: int, b: str)")

    # Check that the __annotations__ attribute has been correctly set
    assert func_no_annotations.__annotations__ == {
        "a": int,
        "b": str,
    }, "__annotations__ not correctly set by make_signature"


def test_callable_sig():
    """Test callable_sig."""
    # Function
    def func(a, b, context=None):
        return a + b

    assert callable_sig(func) == "func(a, b, context=None)"
    assert callable_sig(func, skip_context=True) == "func(a, b)"

    # Lambda function
    lambda_func = lambda a, b, context=None: a + b
    assert callable_sig(lambda_func) == "lambda(a, b, context=None)"
    assert callable_sig(lambda_func, skip_context=True) == "lambda(a, b)"

    # Class with a __call__ method
    class CallableClass:
        def __call__(self, a, b, context=None):
            return a + b

    assert callable_sig(CallableClass) == "CallableClass(self, a, b, context=None)"
    assert callable_sig(CallableClass, skip_context=True) == "CallableClass(self, a, b)"

    # Instance of a class with a __call__ method
    callable_instance = CallableClass()
    assert callable_sig(callable_instance) == "CallableClass(a, b, context=None)"
    assert callable_sig(callable_instance, skip_context=True) == "CallableClass(a, b)"

    # Built-in function
    assert callable_sig(print) == "print(*args, **kwargs)"
    assert callable_sig(print, skip_context=True) == "print(*args, **kwargs)"

    # Partial function
    partial_func = partial(func, b=3)
    assert callable_sig(partial_func) == "func(a, context=None)"
    assert callable_sig(partial_func, skip_context=True) == "func(a)"


def test_callable_doc():
    """Test callable_doc."""
    # Function with docstring
    def func_with_doc(a, b):
        "This is a function with a docstring"
        return a + b

    assert callable_doc(func_with_doc) == "This is a function with a docstring"

    # Function without docstring
    def func_without_doc(a, b):
        return a + b

    assert callable_doc(func_without_doc) == None

    # Partial function with docstring
    def partial_func_with_doc(a, b=3):
        "This is a partial function with a docstring"
        return a + b

    partial_func = partial(partial_func_with_doc, b=3)
    assert callable_doc(partial_func) == "This is a partial function with a docstring"
