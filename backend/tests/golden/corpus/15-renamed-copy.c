#include <stdio.h>

int total(int lhs, int rhs) {
    return lhs + rhs;
}

int main(void) {
    int lhs = 0;
    int rhs = 0;
    if (scanf("%d %d", &lhs, &rhs) != 2) {
        return 1;
    }
    printf("%d\n", total(lhs, rhs));
    return 0;
}
