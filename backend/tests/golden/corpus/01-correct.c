#include <stdio.h>

int add(int a, int b) {
    return a + b;
}

int main(void) {
    int a = 0;
    int b = 0;
    if (scanf("%d %d", &a, &b) != 2) {
        return 1;
    }
    printf("%d\n", add(a, b));
    return 0;
}
