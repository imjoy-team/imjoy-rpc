pip install -U twine
pip install -U wheel
pip install -U setuptools
rm -rf ./build
rm ./dist/*
python3 setup.py sdist bdist_wheel
twine upload dist/*
rm -rf ./build
